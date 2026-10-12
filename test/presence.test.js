'use strict';

const { expect } = require('chai');
const PresenceTracker = require('../build/lib/presence.js').default;
const { normalizeMac, splitMacs } = require('../build/lib/presence.js');

const ROUTER = '864088062647128';
const PHONE = 'a1:b2:c3:d4:e5:f6';
const WATCH = '00:11:22:33:44:55';
const NS = 'teltonika.0';

function makeAdapter(stored = {}, existing = {}) {
    const objects = {};
    const states = {};
    const writes = {};
    const warnings = [];
    const deleted = [];
    return {
        namespace: NS,
        objects,
        states,
        writes,
        warnings,
        deleted,
        log: { info: () => {}, warn: message => warnings.push(message), error: () => {}, debug: () => {} },
        getForeignObjectsAsync: async () => existing,
        delObjectAsync: async id => {
            deleted.push(id);
        },
        extendObjectAsync: async (id, obj) => {
            objects[id] = JSON.parse(JSON.stringify(obj));
        },
        getStatesAsync: async () => stored,
        setStateAsync: async (id, val, ack) => {
            states[id] = { val, ack };
            writes[id] = (writes[id] || 0) + 1;
        },
    };
}

/** `grace` in seconds, kept tiny so expiry can be observed without waiting */
function makeTracker(entries, options = {}, adapter = makeAdapter()) {
    const tracker = new PresenceTracker(adapter, entries, { grace: 60, ...options });
    return { adapter, tracker };
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const val = (adapter, id) => adapter.states[id]?.val;

describe('normalizeMac', () => {
    it('accepts every notation a device or a user may write', () => {
        expect(normalizeMac('A1:B2:C3:D4:E5:F6')).to.equal('a1b2c3d4e5f6');
        expect(normalizeMac('a1-b2-c3-d4-e5-f6')).to.equal('a1b2c3d4e5f6');
        expect(normalizeMac('a1b2.c3d4.e5f6')).to.equal('a1b2c3d4e5f6');
        // The hotspot table hands out a binary PhysAddress, which arrives hex encoded
        expect(normalizeMac('a1b2c3d4e5f6')).to.equal('a1b2c3d4e5f6');
    });

    it('rejects anything that is not twelve hex digits rather than guessing', () => {
        expect(normalizeMac('a1:b2:c3:d4:e5')).to.equal('');
        expect(normalizeMac('not a mac')).to.equal('');
        expect(normalizeMac('')).to.equal('');
    });

    it('splits the several addresses of one person', () => {
        expect(splitMacs(`${PHONE}, ${WATCH}; xx`)).to.deep.equal({
            macs: ['a1b2c3d4e5f6', '001122334455'],
            invalid: ['xx'],
        });
    });
});

describe('PresenceTracker', () => {
    it('ignores a row without a name or without a usable address, and says so', () => {
        const { adapter, tracker } = makeTracker([
            { name: '', mac: PHONE },
            { name: 'Broken', mac: 'xx' },
            { name: 'Off', mac: PHONE, enabled: false },
            { name: 'Phone', mac: PHONE },
        ]);

        expect(tracker.size).to.equal(1);
        // The disabled row is a deliberate choice; "xx" is reported as unusable and its row as ignored
        expect(adapter.warnings).to.have.length(3);
    });

    it('ignores a second entry that would land on the same object id', () => {
        const { adapter, tracker } = makeTracker([
            { name: 'My Phone', mac: PHONE },
            { name: 'My.Phone', mac: 'aabbccddeeff' },
        ]);

        expect(tracker.size).to.equal(1);
        expect(adapter.warnings).to.have.length(1);
    });

    it('creates the person below presence.persons with its name in native.person', async () => {
        const { adapter, tracker } = makeTracker([{ name: 'Anna', group: 'Family', mac: PHONE }]);
        await tracker.start();
        tracker.stop();

        expect(adapter.objects['presence.persons.Anna']).to.deep.include({
            type: 'channel',
            native: { person: 'Anna', group: 'Family' },
        });
        expect(adapter.objects['presence.persons.Anna.present']).to.have.property('type', 'state');
        expect(adapter.objects['presence.groups.Family.allPresent']).to.have.property('type', 'state');
        expect(adapter.objects).to.not.have.property('presence.guests');
    });

    it('deletes what earlier versions or removed persons left behind', async () => {
        const adapter = makeAdapter(
            {},
            {
                [`${NS}.presence.Phone`]: {},
                [`${NS}.presence.Phone.connected`]: {},
                [`${NS}.presence.anyone`]: {},
                [`${NS}.presence.persons.Anna`]: {},
            },
        );
        const { tracker } = makeTracker([{ name: 'Anna', mac: PHONE }], {}, adapter);
        await tracker.start();
        tracker.stop();

        expect(adapter.deleted).to.deep.equal(['presence.Phone.connected', 'presence.anyone', 'presence.Phone']);
    });

    it('cleans up even with nothing configured', async () => {
        const adapter = makeAdapter({}, { [`${NS}.presence`]: {}, [`${NS}.presence.count`]: {} });
        const { tracker } = makeTracker([], {}, adapter);

        await tracker.start();
        await tracker.report(ROUTER, [{ mac: PHONE }]);
        tracker.stop();

        expect(tracker.enabled).to.equal(false);
        expect(adapter.deleted).to.deep.equal(['presence.count', 'presence']);
        expect(Object.keys(adapter.states)).to.have.length(0);
    });

    it('takes the first sighting as the starting point, not as an arrival', async () => {
        const { adapter, tracker } = makeTracker([{ name: 'Phone', mac: 'A1B2C3D4E5F6' }]);
        await tracker.start();

        await tracker.report(ROUTER, [{ mac: PHONE, ssid: 'Home' }]);
        tracker.stop();

        expect(val(adapter, 'presence.persons.Phone.present')).to.equal(true);
        expect(val(adapter, 'presence.persons.Phone.lastArrival')).to.equal(0);
        expect(val(adapter, 'presence.persons.Phone.history')).to.equal('[]');
        expect(val(adapter, 'presence.persons.Phone.router')).to.equal(ROUTER);
        expect(val(adapter, 'presence.persons.Phone.ssid')).to.equal('Home');
        expect(val(adapter, 'presence.persons.Phone.devices')).to.equal('A1:B2:C3:D4:E5:F6');
        expect(val(adapter, 'presence.present')).to.equal(true);
        expect(val(adapter, 'presence.presentCount')).to.equal(1);
        expect(val(adapter, 'presence.presentNames')).to.equal('Phone');
    });

    it('is present through any of its devices', async () => {
        const { adapter, tracker } = makeTracker([{ name: 'Anna', mac: `${PHONE}, ${WATCH}` }]);
        await tracker.start();

        await tracker.report(ROUTER, [{ mac: WATCH }]);
        tracker.stop();

        expect(val(adapter, 'presence.persons.Anna.present')).to.equal(true);
        expect(val(adapter, 'presence.persons.Anna.devices')).to.equal('00:11:22:33:44:55');
    });

    it('holds a person present while a device is merely missing from one poll', async () => {
        const { adapter, tracker } = makeTracker([{ name: 'Phone', mac: PHONE }]);
        await tracker.start();

        await tracker.report(ROUTER, [{ mac: PHONE, ssid: 'Home' }]);
        // A sleeping phone leaves the association list and comes back, which must not count as leaving
        await tracker.report(ROUTER, []);
        tracker.stop();

        expect(val(adapter, 'presence.persons.Phone.present')).to.equal(true);
    });

    it('records the departure at the last sighting and the next arrival', async () => {
        // 50 ms, so the expiry can be observed without a clock of its own
        const { adapter, tracker } = makeTracker([{ name: 'Phone', mac: PHONE }], { grace: 0.05 });
        await tracker.start();

        await tracker.report(ROUTER, [{ mac: PHONE, ssid: 'Home' }]);
        const lastSeen = val(adapter, 'presence.persons.Phone.lastSeen');

        await wait(80);
        await tracker.report(ROUTER, []);
        expect(val(adapter, 'presence.persons.Phone.present')).to.equal(false);
        expect(val(adapter, 'presence.persons.Phone.lastDeparture')).to.equal(lastSeen);
        expect(val(adapter, 'presence.present')).to.equal(false);
        expect(val(adapter, 'presence.absentNames')).to.equal('Phone');

        await tracker.report(ROUTER, [{ mac: PHONE, ssid: 'Home' }]);
        tracker.stop();

        expect(val(adapter, 'presence.persons.Phone.present')).to.equal(true);
        expect(val(adapter, 'presence.persons.Phone.lastArrival')).to.be.above(lastSeen);
        const history = JSON.parse(val(adapter, 'presence.persons.Phone.history'));
        expect(history.map(event => event.present)).to.deep.equal([true, false]);
    });

    it('decides "absent" for a person never seen only after the grace period, without an event', async () => {
        const { adapter, tracker } = makeTracker([{ name: 'Phone', mac: PHONE }], { grace: 0.05 });
        await tracker.start();
        await wait(80);
        await tracker.report(ROUTER, []);
        tracker.stop();

        expect(val(adapter, 'presence.persons.Phone.present')).to.equal(false);
        expect(val(adapter, 'presence.persons.Phone.history')).to.equal('[]');
        expect(val(adapter, 'presence.persons.Phone.lastDeparture')).to.equal(0);
        expect(val(adapter, 'presence.absentCount')).to.equal(1);
    });

    it('takes over the stored values after a restart', async () => {
        const now = Date.now();
        const base = `${NS}.presence.persons.Phone`;
        const adapter = makeAdapter({
            [`${base}.present`]: { val: true, ts: now },
            [`${base}.lastArrival`]: { val: now - 1000, ts: now },
            [`${base}.lastSeen`]: { val: now - 500, ts: now },
            [`${base}.presentToday`]: { val: 42, ts: now },
            [`${base}.history`]: { val: JSON.stringify([{ ts: now - 1000, present: true }]), ts: now },
        });
        const { tracker } = makeTracker([{ name: 'Phone', mac: PHONE }], {}, adapter);
        await tracker.start();
        tracker.stop();

        // still within the grace period of the stored sighting
        expect(val(adapter, 'presence.persons.Phone.present')).to.equal(true);
        expect(val(adapter, 'presence.persons.Phone.lastArrival')).to.equal(now - 1000);
        expect(val(adapter, 'presence.persons.Phone.presentToday')).to.equal(42);
        expect(JSON.parse(val(adapter, 'presence.persons.Phone.history'))).to.have.length(1);
    });

    it('summarises groups', async () => {
        const { adapter, tracker } = makeTracker([
            { name: 'Anna', group: 'Family', mac: PHONE },
            { name: 'Max', group: 'Family', mac: WATCH },
        ]);
        await tracker.start();
        await tracker.report(ROUTER, [{ mac: PHONE }, { mac: WATCH }]);
        tracker.stop();

        expect(val(adapter, 'presence.groups.Family.allPresent')).to.equal(true);
        expect(val(adapter, 'presence.groups.Family.presentNames')).to.equal('Anna, Max');
        const json = JSON.parse(val(adapter, 'presence.groups.Family.json'));
        expect(json[0]).to.include({ name: 'Anna', id: `${NS}.presence.persons.Anna`, group: 'Family' });
    });

    it('counts guests by SSID and the stations nobody watches, without a state per MAC', async () => {
        const { adapter, tracker } = makeTracker([{ name: 'Phone', mac: PHONE }], {
            guestSsids: ['Guests'],
            unknown: true,
        });
        await tracker.start();
        await tracker.report(ROUTER, [
            { mac: PHONE, ssid: 'Home' },
            { mac: 'aa:aa:aa:aa:aa:01', ssid: 'Guests' },
            { mac: 'aa:aa:aa:aa:aa:02', ssid: 'Home' },
        ]);
        // the same stranger roaming to a second router counts once
        await tracker.report('second', [{ mac: 'aa:aa:aa:aa:aa:02', ssid: 'Home' }]);
        tracker.stop();

        expect(val(adapter, 'presence.guests.count')).to.equal(1);
        expect(val(adapter, 'presence.guests.names')).to.equal('AA:AA:AA:AA:AA:01');
        expect(val(adapter, 'presence.unknown.count')).to.equal(1);
        expect(JSON.parse(val(adapter, 'presence.unknown.json'))[0]).to.include({ mac: 'AA:AA:AA:AA:AA:02' });
        expect(Object.keys(adapter.objects).filter(id => /aa_?aa/i.test(id))).to.have.length(0);
    });

    it('rewrites only lastSeen while a person stays where it was', async () => {
        const { adapter, tracker } = makeTracker([{ name: 'Phone', mac: PHONE }]);
        await tracker.start();
        await tracker.report(ROUTER, [{ mac: PHONE, ssid: 'Home' }]);

        const before = { ...adapter.writes };
        await wait(5);
        await tracker.report(ROUTER, [{ mac: PHONE, ssid: 'Home' }]);
        tracker.stop();

        expect(adapter.writes['presence.persons.Phone.present']).to.equal(before['presence.persons.Phone.present']);
        expect(adapter.writes['presence.persons.Phone.ssid']).to.equal(before['presence.persons.Phone.ssid']);
        expect(adapter.writes['presence.present']).to.equal(before['presence.present']);
        expect(adapter.writes['presence.persons.Phone.lastSeen']).to.equal(
            before['presence.persons.Phone.lastSeen'] + 1,
        );
    });

    it('lists the persons for the widgets', () => {
        const { tracker } = makeTracker([
            { name: 'Anna', group: 'Family', mac: PHONE },
            { name: 'Max', mac: WATCH },
        ]);
        const info = tracker.info();
        expect(info.groups).to.deep.equal(['Family']);
        expect(info.persons.map(person => person.name)).to.deep.equal(['Anna', 'Max']);
    });
});
