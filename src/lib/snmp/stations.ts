import SnmpClient, { isTimeout, type SnmpTarget } from './client';
import { FAMILY_OIDS } from './oids.generated';
import { clientsWithSsid, walkColumn } from './poller';
import { FW_VERSION, PRODUCT_CODE } from './scan';
import { normalizeMac, splitMacs } from '../presence';
import type { PresenceDeviceEntry } from '../../types';

/**
 * Reading the currently associated Wi-Fi stations of a device, so the presence table can be filled from the
 * admin page instead of by typing MAC addresses by hand.
 *
 * A read of its own rather than a look at what the pollers hold: the admin page needs this before anything is
 * configured, and at that point there is no `clients` branch switched on and possibly no poller at all.
 */

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

/** `A1:B2:C3:D4:E5:F6` -> `client_d4e5f6`, a placeholder name that is unique and obviously meant to be edited */
export function suggestName(mac: string): string {
    const hex = normalizeMac(mac);
    return hex ? `client_${hex.slice(6)}` : 'client';
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

        const stations = clientsWithSsid(macs, ifaceIndices, ssids).map(station => ({
            ...station,
            host: target.host,
            device,
            randomised: isRandomisedMac(station.mac),
        }));
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
 * station already listed under any notation is not appended twice. New rows arrive **inactive**: a read finds
 * every phone in range of the access point, including the neighbours', and which of them is to be watched is
 * not the adapter's guess to make.
 */
export function mergeStations(
    existing: PresenceDeviceEntry[] | undefined,
    found: Station[],
): { devices: PresenceDeviceEntry[]; added: Station[] } {
    const current = existing || [];
    // a row may hold several addresses of one person
    const known = new Set(current.flatMap(entry => splitMacs(entry.mac).macs));
    const names = new Set(current.map(entry => (entry.name || '').trim()).filter(Boolean));

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
        ...current,
        ...added.map(station => {
            let name = suggestName(station.mac);
            // The name becomes an object id, so a collision with a row the user named must not happen
            for (let suffix = 2; names.has(name); suffix++) {
                name = `${suggestName(station.mac)}_${suffix}`;
            }
            names.add(name);
            return { enabled: false, name, mac: station.mac };
        }),
    ];
    return { devices, added };
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
                station.ssid ? `SSID ${station.ssid}` : null,
                station.randomised ? 'random address, so a phone or tablet' : 'fixed address',
                isNew.has(normalizeMac(station.mac)) ? 'added' : 'already listed',
            ].filter(Boolean);
            lines.push(`    ${station.mac} — ${hints.join(', ')}`);
        }
    }
    return lines;
}
