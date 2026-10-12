'use strict';

const { expect } = require('chai');
const {
    isRandomisedMac,
    suggestName,
    mergeStations,
    describeStations,
} = require('../build/lib/snmp/stations.js');

/** The shape `readStations` hands out, which is all `mergeStations` and `describeStations` look at */
function station(mac, ssid = 'Home', host = '192.168.1.1') {
    return { mac, ssid, host, device: 'RUTC50', randomised: isRandomisedMac(mac) };
}

describe('isRandomisedMac', () => {
    it('recognises the per-network address a phone makes up', () => {
        // Bit 0x02 of the first octet set: a2, 7e, 06 are locally administered
        expect(isRandomisedMac('A2:B2:C3:D4:E5:F6')).to.equal(true);
        expect(isRandomisedMac('7e:ab:cd:ef:01:02')).to.equal(true);
        expect(isRandomisedMac('06:00:00:00:00:01')).to.equal(true);
    });

    it('leaves a burnt-in vendor address alone', () => {
        expect(isRandomisedMac('A1:B2:C3:D4:E5:F6')).to.equal(false);
        // An Apple OUI, globally unique and therefore not randomised
        expect(isRandomisedMac('dc:a9:04:11:22:33')).to.equal(false);
    });

    it('says no rather than guessing about an unusable address', () => {
        expect(isRandomisedMac('not a mac')).to.equal(false);
        expect(isRandomisedMac('')).to.equal(false);
    });
});

describe('suggestName', () => {
    it('names a row after the last three octets, which is unique enough to edit', () => {
        expect(suggestName('A1:B2:C3:D4:E5:F6')).to.equal('client_d4e5f6');
        expect(suggestName('a1b2c3d4e5f6')).to.equal('client_d4e5f6');
    });

    it('falls back without inventing digits', () => {
        expect(suggestName('xx')).to.equal('client');
    });
});

describe('mergeStations', () => {
    it('appends an unknown station as an inactive row', () => {
        const { devices, added } = mergeStations([], [station('A1:B2:C3:D4:E5:F6')]);

        expect(added).to.have.length(1);
        expect(devices).to.deep.equal([{ enabled: false, name: 'client_d4e5f6', mac: 'A1:B2:C3:D4:E5:F6' }]);
    });

    it('copes with a table that does not exist yet', () => {
        expect(mergeStations(undefined, [station('A1:B2:C3:D4:E5:F6')]).devices).to.have.length(1);
    });

    it('never touches a row the user filled in', () => {
        const mine = { enabled: true, name: 'My Phone', mac: 'a1-b2-c3-d4-e5-f6', grace: 600 };

        const { devices, added } = mergeStations([mine], [station('A1:B2:C3:D4:E5:F6')]);

        // Listed already, only written differently
        expect(added).to.have.length(0);
        expect(devices).to.deep.equal([mine]);
    });

    it('adds a station reported by two routers once', () => {
        const roaming = [station('A1:B2:C3:D4:E5:F6', 'Home', '192.168.1.1'), station('a1b2c3d4e5f6', 'Garage', '192.168.1.2')];

        expect(mergeStations([], roaming).devices).to.have.length(1);
    });

    it('does not land on the name of an existing row', () => {
        const existing = { enabled: true, name: 'client_d4e5f6', mac: '00:11:22:33:44:55' };

        const { devices } = mergeStations([existing], [station('A1:B2:C3:D4:E5:F6')]);

        expect(devices[1].name).to.equal('client_d4e5f6_2');
    });

    it('skips an address it could not read', () => {
        expect(mergeStations([], [station('N/A')]).devices).to.have.length(0);
    });
});

describe('describeStations', () => {
    it('tells a phone from a fixed device and marks what was added', () => {
        const phone = station('A2:B2:C3:D4:E5:F6');
        const printer = station('A1:B2:C3:D4:E5:F6');
        const scans = [{ host: '192.168.1.1', device: 'RUTC50', stations: [phone, printer] }];

        const lines = describeStations(scans, [phone]).join('\n');

        expect(lines).to.contain('RUTC50 192.168.1.1: 2 station(s)');
        expect(lines).to.contain('A2:B2:C3:D4:E5:F6 — SSID Home, random address, so a phone or tablet, added');
        expect(lines).to.contain('A1:B2:C3:D4:E5:F6 — SSID Home, fixed address, already listed');
    });

    it('reports per device why it contributed nothing', () => {
        const scans = [
            { host: '192.168.1.1', device: '', stations: [], error: 'no Teltonika device answered' },
            { host: '192.168.1.2', device: 'RUTC50', stations: [] },
            { host: '192.168.1.3', device: 'TSW202', stations: [], noWifi: true },
        ];

        expect(describeStations(scans, [])).to.deep.equal([
            '192.168.1.1: no Teltonika device answered',
            'RUTC50 192.168.1.2: no station associated',
            'TSW202 192.168.1.3: no Wi-Fi, skipped',
        ]);
    });
});
