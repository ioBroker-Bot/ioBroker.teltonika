import type DeviceStates from './states';
import { sanitizeId } from './states';

/**
 * Presence of named devices, derived from the MAC addresses a router reports as associated to its Wi-Fi.
 *
 * Deliberately not a state per observed MAC: only the devices the user named here reach the object tree, so
 * switching presence on does not turn the tree into a rolling log of every visitor hardware address. The
 * optional Wi-Fi client list is what exposes all of them, and it stays off unless asked for.
 *
 * Why a grace period rather than the association list as-is: a phone drops out of that list while it sleeps
 * and reappears seconds later, and it leaves the list for good only some time after walking out of range.
 * Taken literally the list would toggle a presence state all day, so a sighting keeps the device present
 * until it has been missing for `grace` seconds.
 */

export interface PresenceEntry {
    enabled?: boolean;
    /** Object id below `presence`, so two entries must not carry the same name */
    name: string;
    /** As the router reports it. Separators and case are irrelevant, `A1:B2…` and `a1b2…` are the same. */
    mac: string;
    /** Seconds the device stays present after its last sighting. Empty falls back to the configured default. */
    grace?: number | string;
}

/** One associated station, as a transport reports it */
export interface PresenceSighting {
    mac: string;
    ssid?: string | null;
}

/** Long enough to survive a sleeping phone, short enough to notice someone leaving */
export const DEFAULT_GRACE = 180;

/** A device that is already away expires without anyone reporting anything, so the sweep runs on its own */
const SWEEP_INTERVAL = 10000;

/**
 * Compare MAC addresses by their twelve hex digits.
 *
 * Every source writes them differently: `wIfaceClientMAC` is a DisplayString holding `A1:B2:C3:D4:E5:F6`, the
 * hotspot table a binary PhysAddress that arrives hex encoded, and the user types whatever their phone shows
 * them. Anything that is not twelve hex digits is rejected rather than guessed at.
 */
export function normalizeMac(raw: string): string {
    const hex = (raw || '').toLowerCase().replace(/[^0-9a-f]/g, '');
    return hex.length === 12 ? hex : '';
}

interface Watched {
    /** Object id below `presence` */
    id: string;
    name: string;
    mac: string;
    /** Milliseconds, already resolved against the default */
    grace: number;
    /** 0 while the device has not been seen since the adapter started */
    lastSeen: number;
    router: string | null;
    ssid: string | null;
    /** Last values written, so a poll every few seconds does not rewrite unchanged states */
    written: { connected: boolean | null; lastSeen: number; router: string | null; ssid: string | null };
}

const CONNECTED: ioBroker.StateCommon = {
    name: 'Present',
    type: 'boolean',
    role: 'indicator.presence',
    read: true,
    write: false,
};

const LAST_SEEN: ioBroker.StateCommon = {
    name: 'Last seen',
    type: 'number',
    role: 'value.time',
    read: true,
    write: false,
};

const ROUTER: ioBroker.StateCommon = {
    name: 'Seen by',
    type: 'string',
    role: 'info.name',
    read: true,
    write: false,
};

const SSID: ioBroker.StateCommon = {
    name: 'SSID',
    type: 'string',
    role: 'info.name',
    read: true,
    write: false,
};

export default class PresenceTracker {
    private readonly adapter: ioBroker.Adapter;
    private readonly states: DeviceStates;
    private readonly watched: Watched[] = [];
    /** Normalised MAC to the entries watching it — two people may well share a tablet */
    private readonly byMac = new Map<string, Watched[]>();
    private timer: NodeJS.Timeout | null = null;
    private anyone: boolean | null = null;
    private present: number | null = null;

    constructor(
        adapter: ioBroker.Adapter,
        states: DeviceStates,
        entries: PresenceEntry[],
        defaultGrace = DEFAULT_GRACE,
    ) {
        this.adapter = adapter;
        this.states = states;

        const used = new Set<string>();
        for (const entry of entries || []) {
            if (entry.enabled === false) {
                continue;
            }
            const mac = normalizeMac(entry.mac);
            const name = (entry.name || '').trim();
            if (!name || !mac) {
                this.adapter.log.warn(
                    `Presence entry "${entry.name || entry.mac}" was ignored: it needs a name and a MAC ` +
                        `address of twelve hex digits`,
                );
                continue;
            }
            const id = sanitizeId(name);
            if (used.has(id)) {
                this.adapter.log.warn(`Presence entry "${name}" collides with an earlier one and was ignored`);
                continue;
            }
            used.add(id);

            const grace = Number(entry.grace) > 0 ? Number(entry.grace) : defaultGrace;
            const watched: Watched = {
                id,
                name,
                mac,
                grace: grace * 1000,
                lastSeen: 0,
                router: null,
                ssid: null,
                written: { connected: null, lastSeen: 0, router: null, ssid: null },
            };
            this.watched.push(watched);
            this.byMac.set(mac, [...(this.byMac.get(mac) || []), watched]);
        }
    }

    get size(): number {
        return this.watched.length;
    }

    /**
     * Create the objects and start out away.
     *
     * Nothing is known about a device before the first poll, and `false` is the honest answer to "has this
     * phone been seen since the adapter started" — the same reason `main.ts` forces every `alive` to false.
     */
    async start(): Promise<void> {
        if (!this.watched.length) {
            return;
        }
        await this.states.ensureChannel('presence', 'Presence');
        for (const watched of this.watched) {
            await this.states.ensureChannel(`presence.${watched.id}`, watched.name);
        }
        await this.evaluate();
        this.timer = setInterval(() => void this.evaluate(), SWEEP_INTERVAL);
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    /** Hand in the stations one device reports. An unknown MAC is counted nowhere and kept nowhere. */
    async report(deviceId: string, clients: PresenceSighting[]): Promise<void> {
        if (!this.watched.length) {
            return;
        }
        const now = Date.now();
        for (const client of clients) {
            for (const watched of this.byMac.get(normalizeMac(client.mac)) || []) {
                watched.lastSeen = now;
                watched.router = deviceId;
                watched.ssid = client.ssid || null;
            }
        }
        await this.evaluate(now);
    }

    private async evaluate(now = Date.now()): Promise<void> {
        let present = 0;
        for (const watched of this.watched) {
            const connected = watched.lastSeen > 0 && now - watched.lastSeen <= watched.grace;
            if (connected) {
                present++;
            }
            await this.publish(watched, connected);
        }

        if (this.present !== present) {
            this.present = present;
            await this.states.writeValue(
                'presence.count',
                { name: 'Devices present', type: 'number', role: 'value', read: true, write: false },
                present,
            );
        }
        const anyone = present > 0;
        if (this.anyone !== anyone) {
            this.anyone = anyone;
            await this.states.writeValue(
                'presence.anyone',
                { name: 'Anyone present', type: 'boolean', role: 'indicator.presence', read: true, write: false },
                anyone,
            );
        }
    }

    private async publish(watched: Watched, connected: boolean): Promise<void> {
        const base = `presence.${watched.id}`;
        const written = watched.written;

        if (written.connected !== connected) {
            written.connected = connected;
            this.adapter.log.debug(`Presence: ${watched.name} is ${connected ? 'present' : 'away'}`);
            await this.states.writeValue(`${base}.connected`, CONNECTED, connected);
        }
        if (watched.lastSeen && written.lastSeen !== watched.lastSeen) {
            written.lastSeen = watched.lastSeen;
            await this.states.writeValue(`${base}.lastSeen`, LAST_SEEN, watched.lastSeen);
        }
        if (written.router !== watched.router) {
            written.router = watched.router;
            await this.states.writeValue(`${base}.router`, ROUTER, watched.router);
        }
        if (written.ssid !== watched.ssid) {
            written.ssid = watched.ssid;
            await this.states.writeValue(`${base}.ssid`, SSID, watched.ssid);
        }
    }
}
