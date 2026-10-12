import { sanitizeId } from './states';
import type { PresenceDeviceEntry } from '../types';

/**
 * Presence of persons, derived from the MAC addresses the routers report as associated to their Wi-Fi - the
 * functions of fb-checkpresence, with the same object tree as ioBroker.tr-064, so that the widgets of both
 * adapters read it the same way.
 *
 * Every row of the *Presence* tab is a person with one or more MAC addresses (a phone and a watch, or the
 * random addresses one phone uses in two networks) and an optional group:
 *
 * - `presence.persons.<name>`: `present`, `lastArrival`/`lastDeparture` (ms), `presentSince`/`absentSince`
 *   (minutes), `presentToday`/`absentToday` (minutes since midnight), `devices` (the MACs seen), `history`
 *   (the last comings and goings as JSON, newest first) and `lastSeen`, `router`, `ssid` of the last sighting
 * - `presence.groups.<group>` and `presence` itself: `present` (anybody), `allPresent`, `presentCount`,
 *   `absentCount`, `presentNames`, `absentNames`, `json`
 * - `presence.guests` (stations of the guest SSIDs) and `presence.unknown` (stations nobody watches): a count
 *   and one JSON list, never a state per MAC - the tree must not become a log of every visitor's address.
 *
 * Why a grace period rather than the association list as-is: a phone drops out of that list while it sleeps
 * and reappears seconds later, and it leaves the list for good only some time after walking out of range.
 * Taken literally the list would toggle the presence all day, so a sighting keeps the person present until
 * none of its devices was seen for `grace` seconds - and the departure is then the last sighting.
 */

/** One associated station, as a transport reports it */
export interface PresenceSighting {
    mac: string;
    ssid?: string | null;
}

export interface PresenceOptions {
    /** Seconds a sighting counts, unless the row overrides it */
    grace?: number;
    /** Number of comings and goings kept in `history` */
    historyLength?: number;
    /** SSIDs of the guest networks - their stations are guests, not unknown */
    guestSsids?: string[];
    /** Write `presence.unknown` */
    unknown?: boolean;
}

interface PresenceEvent {
    ts: number;
    present: boolean;
}

/** The persons and groups for the widgets, answer of the message `presence` */
export interface PresenceInfo {
    persons: {
        name: string;
        id: string;
        group: string;
        present: boolean | null;
        lastArrival: number;
        lastDeparture: number;
    }[];
    groups: string[];
}

/** Long enough to survive a sleeping phone, short enough to notice someone leaving */
export const DEFAULT_GRACE = 180;

export const DEFAULT_HISTORY = 50;
const MAX_HISTORY = 1000;

/** A person who is already away expires without anyone reporting anything, so the sweep runs on its own */
const SWEEP_INTERVAL = 10000;

const MINUTE = 60_000;

/** A longer gap between two evaluations (adapter stopped) is not added to the sums of the day */
const MAX_GAP = 10 * MINUTE;

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

/** The MAC addresses of a row, separated by comma or semicolon, normalised. Unusable parts are in `invalid`. */
export function splitMacs(raw: string | undefined): { macs: string[]; invalid: string[] } {
    const macs: string[] = [];
    const invalid: string[] = [];
    for (const part of (raw || '').split(/[,;]/)) {
        const text = part.trim();
        if (!text) {
            continue;
        }
        const mac = normalizeMac(text);
        if (mac) {
            macs.push(mac);
        } else {
            invalid.push(text);
        }
    }
    return { macs, invalid };
}

/** `a1b2c3d4e5f6` -> `A1:B2:C3:D4:E5:F6` */
function formatMac(mac: string): string {
    return mac.toUpperCase().match(/../g)!.join(':');
}

function dayOf(ts: number): string {
    return new Date(ts).toDateString();
}

function state(
    name: string,
    type: ioBroker.CommonType,
    role: string,
    extra: Partial<ioBroker.StateCommon> = {},
): ioBroker.StateCommon {
    return { name, type, role, read: true, write: false, ...extra };
}

const PERSON_STATES: Record<string, ioBroker.StateCommon> = {
    present: state('Present', 'boolean', 'indicator.presence', { def: false }),
    lastArrival: state('Last arrival', 'number', 'date', { def: 0 }),
    lastDeparture: state('Last departure', 'number', 'date', { def: 0 }),
    presentSince: state('Present since', 'number', 'value', { unit: 'min', def: 0 }),
    absentSince: state('Absent since', 'number', 'value', { unit: 'min', def: 0 }),
    presentToday: state('Present today', 'number', 'value', { unit: 'min', def: 0 }),
    absentToday: state('Absent today', 'number', 'value', { unit: 'min', def: 0 }),
    devices: state('Devices seen', 'string', 'text', { def: '' }),
    history: state('Last comings and goings', 'string', 'json', { def: '[]' }),
    lastSeen: state('Last seen', 'number', 'value.time', { def: 0 }),
    router: state('Seen by', 'string', 'info.name', { def: '' }),
    ssid: state('SSID', 'string', 'info.name', { def: '' }),
};

const SUMMARY_STATES: Record<string, ioBroker.StateCommon> = {
    present: state('Anybody present', 'boolean', 'indicator.presence', { def: false }),
    allPresent: state('All present', 'boolean', 'indicator', { def: false }),
    presentCount: state('Number of present persons', 'number', 'value', { def: 0 }),
    absentCount: state('Number of absent persons', 'number', 'value', { def: 0 }),
    presentNames: state('Present persons', 'string', 'text', { def: '' }),
    absentNames: state('Absent persons', 'string', 'text', { def: '' }),
    json: state('Persons as JSON', 'string', 'json', { def: '[]' }),
};

const STATIONS_STATES: Record<string, ioBroker.StateCommon> = {
    present: state('Any station associated', 'boolean', 'indicator', { def: false }),
    count: state('Number of stations', 'number', 'value', { def: 0 }),
    names: state('Stations', 'string', 'text', { def: '' }),
    json: state('Stations as JSON', 'string', 'json', { def: '[]' }),
};

interface Person {
    name: string;
    group: string;
    /** Object id of the channel, e.g. `presence.persons.Anna` */
    channel: string;
    macs: string[];
    /** Milliseconds, already resolved against the default */
    grace: number;
    /** `null` until the presence was determined once */
    present: boolean | null;
    lastArrival: number;
    lastDeparture: number;
    lastSeen: number;
    router: string;
    ssid: string;
    /** MACs of the person seen within the grace period, with the time of their last sighting */
    seen: Map<string, number>;
    history: PresenceEvent[];
    presentMs: number;
    absentMs: number;
    /** `toDateString()` of the day `presentMs`/`absentMs` belong to */
    day: string;
}

/** A station in `presence.guests/unknown.json` */
interface StationInfo {
    mac: string;
    ssid: string | null;
    router: string;
}

export default class PresenceTracker {
    private readonly adapter: ioBroker.Adapter;
    private readonly persons: Person[] = [];
    /** Normalised MAC to the persons watching it - two people may well share a tablet */
    private readonly byMac = new Map<string, Person[]>();
    /** Group name to the id of its channel */
    private readonly groups = new Map<string, string>();
    /** Device id to the stations it reported last */
    private readonly stations = new Map<string, StationInfo[]>();
    private readonly guestSsids: Set<string>;
    private readonly unknown: boolean;
    private readonly historyLength: number;
    /** Last values written, so a poll every few seconds does not rewrite unchanged states */
    private readonly written = new Map<string, ioBroker.StateValue>();
    private timer: NodeJS.Timeout | null = null;
    private startedAt = 0;
    private lastTick = 0;

    constructor(adapter: ioBroker.Adapter, entries: PresenceDeviceEntry[], options: PresenceOptions = {}) {
        this.adapter = adapter;
        const defaultGrace = Number(options.grace) > 0 ? Number(options.grace) : DEFAULT_GRACE;
        this.historyLength = Math.min(
            MAX_HISTORY,
            Math.max(1, Math.floor(Number(options.historyLength)) || DEFAULT_HISTORY),
        );
        this.guestSsids = new Set((options.guestSsids || []).map(ssid => ssid.trim()).filter(Boolean));
        this.unknown = !!options.unknown;

        const used = new Set<string>();
        const usedGroups = new Set<string>();
        for (const entry of entries || []) {
            if (entry.enabled === false) {
                continue;
            }
            const name = (entry.name || '').trim();
            const { macs, invalid } = splitMacs(entry.mac);
            if (invalid.length) {
                this.adapter.log.warn(
                    `Presence entry "${name || entry.mac}": "${invalid.join('", "')}" is no MAC address of twelve ` +
                        `hex digits and was ignored`,
                );
            }
            if (!name || !macs.length) {
                this.adapter.log.warn(
                    `Presence entry "${name || entry.mac}" was ignored: it needs a name and at least one MAC address`,
                );
                continue;
            }
            const id = sanitizeId(name);
            if (used.has(id.toLowerCase())) {
                this.adapter.log.warn(`Presence entry "${name}" collides with an earlier one and was ignored`);
                continue;
            }
            used.add(id.toLowerCase());

            const group = (entry.group || '').trim();
            if (group && !this.groups.has(group)) {
                let groupId = sanitizeId(group);
                for (let n = 2; usedGroups.has(groupId.toLowerCase()); n++) {
                    groupId = `${sanitizeId(group)}_${n}`;
                }
                usedGroups.add(groupId.toLowerCase());
                this.groups.set(group, `presence.groups.${groupId}`);
            }

            const grace = Number(entry.grace) > 0 ? Number(entry.grace) : defaultGrace;
            const person: Person = {
                name,
                group,
                channel: `presence.persons.${id}`,
                macs,
                grace: grace * 1000,
                present: null,
                lastArrival: 0,
                lastDeparture: 0,
                lastSeen: 0,
                router: '',
                ssid: '',
                seen: new Map(),
                history: [],
                presentMs: 0,
                absentMs: 0,
                day: dayOf(Date.now()),
            };
            this.persons.push(person);
            for (const mac of macs) {
                this.byMac.set(mac, [...(this.byMac.get(mac) || []), person]);
            }
        }
    }

    /** Number of watched persons */
    get size(): number {
        return this.persons.length;
    }

    /** Something to do: persons, guest SSIDs or the unknown stations */
    get enabled(): boolean {
        return !!this.persons.length || !!this.guestSsids.size || this.unknown;
    }

    /**
     * Create the objects, delete the ones nobody wants any more (removed persons, the flat layout of the first
     * presence version) and take over the stored values, so that times, sums and history survive a restart.
     *
     * Runs even with nothing configured, so that switching presence off cleans up after it.
     */
    async start(): Promise<void> {
        const wanted = new Map<string, ioBroker.SettableObject>();
        const channel = (id: string, name: string, native: Record<string, unknown> = {}): void => {
            wanted.set(id, { type: 'channel', common: { name }, native });
        };
        const states = (prefix: string, defs: Record<string, ioBroker.StateCommon>): void => {
            for (const [name, common] of Object.entries(defs)) {
                wanted.set(`${prefix}.${name}`, { type: 'state', common, native: {} });
            }
        };

        if (this.enabled) {
            channel('presence', 'Presence');
        }
        if (this.persons.length) {
            states('presence', SUMMARY_STATES);
            channel('presence.persons', 'Persons');
            for (const person of this.persons) {
                // `native.person` is how the widgets find a person by its name
                channel(person.channel, person.name, { person: person.name, group: person.group });
                states(person.channel, PERSON_STATES);
            }
        }
        if (this.groups.size) {
            channel('presence.groups', 'Groups');
            for (const [group, id] of this.groups) {
                channel(id, group, { group });
                states(id, SUMMARY_STATES);
            }
        }
        if (this.guestSsids.size) {
            channel('presence.guests', 'Guests');
            states('presence.guests', STATIONS_STATES);
        }
        if (this.unknown) {
            channel('presence.unknown', 'Unknown stations');
            states('presence.unknown', STATIONS_STATES);
        }

        const prefix = `${this.adapter.namespace}.`;
        const existing = (await this.adapter.getForeignObjectsAsync(`${prefix}presence*`)) || {};
        const obsolete = Object.keys(existing)
            .map(id => id.substring(prefix.length))
            .filter(id => (id === 'presence' || id.startsWith('presence.')) && !wanted.has(id))
            // children first
            .sort((a, b) => b.length - a.length);
        for (const id of obsolete) {
            await this.adapter.delObjectAsync(id);
        }
        // extendObject keeps `common.custom`, i.e. the settings of history, sql or influxdb
        for (const [id, obj] of wanted) {
            await this.adapter.extendObjectAsync(id, obj);
        }

        if (!this.enabled) {
            return;
        }
        if (this.persons.length) {
            await this.restore();
        }
        this.startedAt = Date.now();
        await this.evaluate();
        this.timer = setInterval(() => void this.evaluate(), SWEEP_INTERVAL);
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    /** Hand in the stations one device reports. A station nobody watches is only counted, never kept by MAC. */
    async report(deviceId: string, clients: PresenceSighting[]): Promise<void> {
        if (!this.enabled) {
            return;
        }
        const now = Date.now();
        const list: StationInfo[] = [];
        for (const client of clients) {
            const mac = normalizeMac(client.mac);
            if (!mac) {
                continue;
            }
            list.push({ mac, ssid: client.ssid || null, router: deviceId });
            for (const person of this.byMac.get(mac) || []) {
                person.seen.set(mac, now);
                person.lastSeen = now;
                person.router = deviceId;
                person.ssid = client.ssid || '';
            }
        }
        this.stations.set(deviceId, list);
        await this.evaluate(now);
    }

    /** The persons and groups for the widgets */
    info(): PresenceInfo {
        return {
            persons: this.persons.map(person => this.personInfo(person)),
            groups: [...this.groups.keys()],
        };
    }

    private personInfo(person: Person): PresenceInfo['persons'][number] {
        return {
            name: person.name,
            id: `${this.adapter.namespace}.${person.channel}`,
            group: person.group,
            present: person.present,
            lastArrival: person.lastArrival,
            lastDeparture: person.lastDeparture,
        };
    }

    private async restore(): Promise<void> {
        const prefix = `${this.adapter.namespace}.`;
        const stored = (await this.adapter.getStatesAsync('presence.persons.*')) || {};
        const today = dayOf(Date.now());
        for (const person of this.persons) {
            const get = (name: string): ioBroker.State | undefined => stored[`${prefix}${person.channel}.${name}`];
            const present = get('present');
            if (present && typeof present.val === 'boolean') {
                person.present = present.val;
            }
            person.lastArrival = Number(get('lastArrival')?.val) || 0;
            person.lastDeparture = Number(get('lastDeparture')?.val) || 0;
            person.lastSeen = Number(get('lastSeen')?.val) || 0;
            person.router = String(get('router')?.val ?? '');
            person.ssid = String(get('ssid')?.val ?? '');
            if (person.present && person.lastSeen) {
                // whoever was present stays so until the grace period of the last sighting is over
                for (const mac of person.macs) {
                    person.seen.set(mac, person.lastSeen);
                }
            }
            try {
                const history = JSON.parse(String(get('history')?.val || '[]')) as PresenceEvent[];
                if (Array.isArray(history)) {
                    person.history = history
                        .filter(event => event && typeof event.ts === 'number')
                        .slice(0, this.historyLength);
                }
            } catch {
                // a broken list starts empty
            }
            const presentToday = get('presentToday');
            if (presentToday && dayOf(presentToday.ts) === today) {
                person.presentMs = (Number(presentToday.val) || 0) * MINUTE;
            }
            const absentToday = get('absentToday');
            if (absentToday && dayOf(absentToday.ts) === today) {
                person.absentMs = (Number(absentToday.val) || 0) * MINUTE;
            }
        }
    }

    private async evaluate(now = Date.now()): Promise<void> {
        const delta = this.lastTick ? Math.min(Math.max(0, now - this.lastTick), MAX_GAP) : 0;
        this.lastTick = now;

        for (const person of this.persons) {
            this.count(person, delta, now);
            for (const [mac, ts] of person.seen) {
                if (now - ts > person.grace) {
                    person.seen.delete(mac);
                }
            }
            const seen = person.seen.size > 0;

            if (person.present === null) {
                // The first determination is no event. "Not seen" is only an answer once every router had the
                // chance to report, i.e. after the grace period.
                if (seen) {
                    person.present = true;
                } else if (now - this.startedAt > person.grace) {
                    person.present = false;
                }
            } else if (seen && !person.present) {
                this.change(person, true, now);
            } else if (!seen && person.present) {
                // gone since the last sighting, not since the grace period ran out
                this.change(person, false, person.lastSeen || now);
            }
            await this.writePerson(person, now);
        }

        if (this.persons.length) {
            await this.writeSummary('presence', this.persons);
            for (const [group, id] of this.groups) {
                await this.writeSummary(
                    id,
                    this.persons.filter(person => person.group === group),
                );
            }
        }

        if (this.guestSsids.size || this.unknown) {
            // a station roaming between two routers is reported by both
            const all = new Map<string, StationInfo>();
            for (const list of this.stations.values()) {
                for (const station of list) {
                    all.set(station.mac, station);
                }
            }
            const stations = [...all.values()];
            const isGuest = (station: StationInfo): boolean => !!station.ssid && this.guestSsids.has(station.ssid);
            if (this.guestSsids.size) {
                await this.writeStations('presence.guests', stations.filter(isGuest));
            }
            if (this.unknown) {
                await this.writeStations(
                    'presence.unknown',
                    stations.filter(station => !this.byMac.has(station.mac) && !isGuest(station)),
                );
            }
        }
    }

    /** Add the time since the last evaluation to the sums of today, which start at 0 at midnight */
    private count(person: Person, delta: number, now: number): void {
        const today = dayOf(now);
        if (person.day !== today) {
            person.day = today;
            person.presentMs = 0;
            person.absentMs = 0;
            // only the part after midnight belongs to today
            delta = Math.min(delta, now - new Date(now).setHours(0, 0, 0, 0));
        }
        if (person.present === true) {
            person.presentMs += delta;
        } else if (person.present === false) {
            person.absentMs += delta;
        }
    }

    private change(person: Person, present: boolean, ts: number): void {
        person.present = present;
        if (present) {
            person.lastArrival = ts;
        } else {
            person.lastDeparture = ts;
        }
        person.history.unshift({ ts, present });
        person.history.length = Math.min(person.history.length, this.historyLength);
        this.adapter.log.debug(`Presence: ${person.name} ${present ? 'came' : 'left'}`);
    }

    private async writePerson(person: Person, now: number): Promise<void> {
        const minutes = (ms: number): number => Math.floor(ms / MINUTE);
        const since = person.present ? person.lastArrival : person.lastDeparture;
        const sinceMinutes = since ? minutes(Math.max(0, now - since)) : 0;
        const base = person.channel;

        await this.write(`${base}.present`, !!person.present);
        await this.write(`${base}.lastArrival`, person.lastArrival);
        await this.write(`${base}.lastDeparture`, person.lastDeparture);
        await this.write(`${base}.presentSince`, person.present ? sinceMinutes : 0);
        await this.write(`${base}.absentSince`, person.present ? 0 : sinceMinutes);
        await this.write(`${base}.presentToday`, minutes(person.presentMs));
        await this.write(`${base}.absentToday`, minutes(person.absentMs));
        await this.write(`${base}.devices`, [...person.seen.keys()].map(formatMac).join(', '));
        await this.write(`${base}.history`, JSON.stringify(person.history));
        await this.write(`${base}.lastSeen`, person.lastSeen);
        await this.write(`${base}.router`, person.router);
        await this.write(`${base}.ssid`, person.ssid);
    }

    private async writeSummary(prefix: string, persons: Person[]): Promise<void> {
        const present = persons.filter(person => person.present);
        const absent = persons.filter(person => !person.present);

        await this.write(`${prefix}.present`, present.length > 0);
        await this.write(`${prefix}.allPresent`, !!persons.length && !absent.length);
        await this.write(`${prefix}.presentCount`, present.length);
        await this.write(`${prefix}.absentCount`, absent.length);
        await this.write(`${prefix}.presentNames`, present.map(person => person.name).join(', '));
        await this.write(`${prefix}.absentNames`, absent.map(person => person.name).join(', '));
        await this.write(`${prefix}.json`, JSON.stringify(persons.map(person => this.personInfo(person))));
    }

    private async writeStations(prefix: string, stations: StationInfo[]): Promise<void> {
        const list = stations
            .map(station => ({ ...station, mac: formatMac(station.mac) }))
            .sort((a, b) => a.mac.localeCompare(b.mac));
        await this.write(`${prefix}.present`, list.length > 0);
        await this.write(`${prefix}.count`, list.length);
        await this.write(`${prefix}.names`, list.map(station => station.mac).join(', '));
        await this.write(`${prefix}.json`, JSON.stringify(list));
    }

    /** Write a value which changed */
    private async write(id: string, val: ioBroker.StateValue): Promise<void> {
        if (this.written.get(id) === val) {
            return;
        }
        this.written.set(id, val);
        await this.adapter.setStateAsync(id, val, true);
    }
}
