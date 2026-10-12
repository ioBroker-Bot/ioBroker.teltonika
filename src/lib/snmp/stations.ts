import { Resolver } from 'node:dns/promises';
import SnmpClient, { isTimeout, type SnmpTarget } from './client';
import { FAMILY_OIDS } from './oids.generated';
import { clientsWithSsid, walkColumn } from './poller';
import { FW_VERSION, PRODUCT_CODE } from './scan';
import { lookupVendor } from '../oui';
import { normalizeMac, splitMacs } from '../presence';
import type { PresenceDeviceEntry } from '../../types';

/**
 * Reading the currently associated Wi-Fi stations of a device, so the presence table can be filled from the
 * admin page instead of by typing MAC addresses by hand.
 *
 * A read of its own rather than a look at what the pollers hold: the admin page needs this before anything is
 * configured, and at that point there is no `clients` branch switched on and possibly no poller at all.
 *
 * A bare MAC address says little, so every station is described as far as it can be: the manufacturer from the
 * IEEE registry (`../oui`), and the host name the router's DHCP server knows — the ARP table of the device
 * (MIB-II, answered by every net-snmp agent) gives the IP address, and a reverse lookup against the device's own
 * DNS server, which serves the names of its DHCP leases, gives the name.
 */

/** `ipNetToMediaPhysAddress`, indexed by `<ifIndex>.<a>.<b>.<c>.<d>` */
const ARP_TABLE = '1.3.6.1.2.1.4.22.1.2';
/** Per name. The device answers from its lease table at once, or not at all. */
const DNS_TIMEOUT = 2000;
/** A name the read made up, which a later read may replace with a better one */
const PLACEHOLDER = /^client_[0-9a-f]{6}(_\d+)?$/;

export interface Station {
    /** As the device reports it, `A1:B2:C3:D4:E5:F6` on these routers */
    mac: string;
    ssid: string | null;
    /** Address of the device that reported the station */
    host: string;
    /** Product code of that device, so a station can be told apart from one behind another router */
    device: string;
    /**
     * A locally administered address, which is what a phone uses per network. The strongest hint the GUI can
     * give: the randomised entries are the phones and tablets, the fixed ones printers, TVs and the like.
     */
    randomised: boolean;
    /** From the ARP table of the device, missing if the station has not talked to it lately */
    ip?: string;
    /** The DHCP host name, without the domain the router appends */
    hostname?: string;
    /** Owner of the address prefix; never known for a randomised address */
    vendor?: string;
}

export interface StationScan {
    host: string;
    device: string;
    stations: Station[];
    /** Why this device contributed nothing, kept so the admin page can say so per device */
    error?: string;
    /** A device without a radio, such as a TSW switch. Not a failure: there is simply nothing to read. */
    noWifi?: boolean;
}

/**
 * Whether the address is locally administered, i.e. made up by the client rather than burnt in.
 *
 * Bit 0x02 of the first octet. Both iOS and Android set it for the per-network random address they use by
 * default, so this separates the personal devices from the stationary ones without any vendor database.
 */
export function isRandomisedMac(mac: string): boolean {
    const hex = normalizeMac(mac);
    if (!hex) {
        return false;
    }
    return (parseInt(hex.slice(0, 2), 16) & 0x02) !== 0;
}

/**
 * The name a new row gets: the host name if the router knows one, otherwise the first word of the manufacturer
 * with the last three octets (`Espressif_d4e5f6`), otherwise the placeholder `client_d4e5f6`, which is unique
 * and obviously meant to be edited.
 */
export function suggestName(mac: string, hostname?: string, vendor?: string): string {
    if (hostname) {
        return hostname;
    }
    const hex = normalizeMac(mac);
    if (!hex) {
        return 'client';
    }
    const brand = (vendor || '').split(/[^A-Za-z0-9]/).find(Boolean);
    return `${brand || 'client'}_${hex.slice(6)}`;
}

/**
 * The ARP table of the device as normalised MAC -> IPv4.
 *
 * `decodeVarbind` hands six bytes over as hex, unless all six happen to be printable — then they arrive as text
 * and are turned back here.
 */
async function readArp(client: SnmpClient): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    for (const [oid, value] of await client.subtree(ARP_TABLE)) {
        const raw = value?.length === 6 ? Buffer.from(value, 'latin1').toString('hex') : value;
        const mac = normalizeMac(raw || '');
        if (mac) {
            result.set(mac, oid.split('.').slice(-4).join('.'));
        }
    }
    return result;
}

/** Host name of an address from the DNS server of the device, `undefined` if it knows none */
async function reverseName(resolver: Resolver, ip: string): Promise<string | undefined> {
    try {
        const [name] = await resolver.reverse(ip);
        // `Duschlicht.lan` -> `Duschlicht`: the domain is the same for every station
        return name?.split('.')[0] || undefined;
    } catch {
        return undefined;
    }
}

/**
 * Adds IP address and host name to the stations. Never throws: the names are a help, a device that does not
 * hand out its ARP table or runs no DNS server still delivers its stations.
 */
async function resolveNames(client: SnmpClient, host: string, stations: Station[]): Promise<void> {
    let arp: Map<string, string>;
    try {
        arp = await readArp(client);
    } catch {
        return;
    }
    const resolver = new Resolver({ timeout: DNS_TIMEOUT, tries: 1 });
    resolver.setServers([host]);
    await Promise.all(
        stations.map(async station => {
            const ip = arp.get(normalizeMac(station.mac) || '');
            if (ip) {
                station.ip = ip;
                station.hostname = await reverseName(resolver, ip);
            }
        }),
    );
}

/**
 * Read the stations one device currently has associated. Never throws: a silent device is a result too.
 *
 * Timeout and retries are left at what the client defaults to, which is what the pollers use. A shorter leash
 * belongs to the address range scan, where hundreds of silent addresses must not each cost seconds — here the
 * device is one the user configured, and a button that gives up earlier than the poller would be a riddle.
 */
export async function readStations(target: SnmpTarget): Promise<StationScan> {
    const client = new SnmpClient({ ...target });
    let device = '';
    try {
        const info = await client.get([FW_VERSION, PRODUCT_CODE]);
        const fwVersion = info.get(FW_VERSION);
        device = info.get(PRODUCT_CODE) || '';
        if (!fwVersion) {
            throw new Error('no Teltonika device answered');
        }

        const family = fwVersion.split('_R_')[0];
        const oids = FAMILY_OIDS[family];
        if (!oids) {
            throw new Error(`no OID table for family "${family}", add its MIB and run "npm run generate-oids"`);
        }
        const table = oids.tables.wIfaceClientTable;
        // A MIB without the client table belongs to a device without Wi-Fi
        if (!table) {
            return { host: target.host, device, stations: [], noWifi: true };
        }

        const macs = await walkColumn(client, table.rowName);
        const ifaceColumn = table.columns.ssidIndex;
        const ifaceIndices = ifaceColumn ? await walkColumn(client, ifaceColumn) : new Map<string, string>();
        const wIface = oids.tables.wIfaceTable;
        const ssids = wIface ? await walkColumn(client, wIface.rowName) : new Map<string, string>();

        const stations: Station[] = clientsWithSsid(macs, ifaceIndices, ssids).map(station => ({
            ...station,
            host: target.host,
            device,
            randomised: isRandomisedMac(station.mac),
            vendor: lookupVendor(station.mac).vendor,
        }));
        await resolveNames(client, target.host, stations);
        return { host: target.host, device, stations };
    } catch (error) {
        return {
            host: target.host,
            device,
            stations: [],
            // A device that is simply not answering is the common case, and the three reasons for it are
            // always the same. Saying so here saves the round trip through the forum.
            error: isTimeout(error)
                ? 'no answer. Enable the SNMP service on the device, and check that the version and the ' +
                  'community match and that the community is not restricted to another host'
                : error instanceof Error
                  ? error.message
                  : String(error),
        };
    } finally {
        client.close();
    }
}

/**
 * Fold the stations found into the configured presence table.
 *
 * Existing rows are returned untouched — a second read must not rename anybody or undo a grace period — and a
 * station already listed under any notation is not appended twice. The one exception is a row that still has
 * the placeholder name an earlier read gave it (`client_d4e5f6`), is inactive and holds just this one address:
 * nobody has touched it, so it gets the better name now known instead of having to be deleted and read again. New rows arrive **inactive**: a read finds
 * every phone in range of the access point, including the neighbours', and which of them is to be watched is
 * not the adapter's guess to make.
 */
export function mergeStations(
    existing: PresenceDeviceEntry[] | undefined,
    found: Station[],
): { devices: PresenceDeviceEntry[]; added: Station[]; renamed: number } {
    const current = existing || [];
    // a row may hold several addresses of one person
    const known = new Set(current.flatMap(entry => splitMacs(entry.mac).macs));
    const names = new Set(current.map(entry => (entry.name || '').trim()).filter(Boolean));

    // The name becomes an object id, so a collision with a row the user named must not happen
    const uniqueName = (station: Station): string => {
        const base = suggestName(station.mac, station.hostname, station.vendor);
        let name = base;
        for (let suffix = 2; names.has(name); suffix++) {
            name = `${base}_${suffix}`;
        }
        names.add(name);
        return name;
    };

    const byMac = new Map(found.map(station => [normalizeMac(station.mac), station]));
    let renamed = 0;
    const kept = current.map(entry => {
        const macs = splitMacs(entry.mac).macs;
        const station = macs.length === 1 ? byMac.get(macs[0]) : undefined;
        const name = (entry.name || '').trim();
        if (!station || entry.enabled || !PLACEHOLDER.test(name)) {
            return entry;
        }
        if (PLACEHOLDER.test(suggestName(station.mac, station.hostname, station.vendor))) {
            return entry;
        }
        names.delete(name);
        renamed++;
        return { ...entry, name: uniqueName(station) };
    });

    const added: Station[] = [];
    for (const station of found) {
        const mac = normalizeMac(station.mac);
        // A station roaming between two routers is reported by both
        if (!mac || known.has(mac)) {
            continue;
        }
        known.add(mac);
        added.push(station);
    }

    const devices = [
        ...kept,
        ...added.map(station => ({ enabled: false, name: uniqueName(station), mac: station.mac })),
    ];
    return { devices, added, renamed };
}

/** One line per station for the log and the result the admin page shows, newly added ones marked */
export function describeStations(scans: StationScan[], added: Station[]): string[] {
    const isNew = new Set(added.map(station => normalizeMac(station.mac)));
    const lines: string[] = [];
    for (const scan of scans) {
        const device = scan.device ? `${scan.device} ${scan.host}` : scan.host;
        if (scan.error) {
            lines.push(`${device}: ${scan.error}`);
            continue;
        }
        if (scan.noWifi) {
            lines.push(`${device}: no Wi-Fi, skipped`);
            continue;
        }
        if (!scan.stations.length) {
            lines.push(`${device}: no station associated`);
            continue;
        }
        lines.push(`${device}: ${scan.stations.length} station(s)`);
        for (const station of scan.stations) {
            const hints = [
                station.hostname ? `"${station.hostname}"` : null,
                station.ip || null,
                station.vendor || null,
                station.ssid ? `SSID ${station.ssid}` : null,
                station.randomised ? 'random address, so a phone or tablet' : 'fixed address',
                isNew.has(normalizeMac(station.mac)) ? 'added' : 'already listed',
            ].filter(Boolean);
            lines.push(`    ${station.mac} — ${hints.join(', ')}`);
        }
    }
    return lines;
}
