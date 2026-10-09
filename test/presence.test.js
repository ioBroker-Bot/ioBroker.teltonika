'use strict';

const { expect } = require('chai');
const DeviceStates = require('../build/lib/states.js').default;
const PresenceTracker = require('../build/lib/presence.js').default;
const { normalizeMac } = require('../build/lib/presence.js');

const ROUTER = '864088062647128';
const PHONE = 'a1:b2:c3:d4:e5:f6';

function makeAdapter() {
    const objects = {};
    const states = {};
    const writes = {};
    const warnings = [];
    return {
        namespace: 'teltonika.0',
        objects,
        states,
        writes,
        warnings,
        log: { info: () => {}, warn: message => warnings.push(message), error: () => {}, debug: () => {} },
        getObjectAsync: async id => objects[id] || null,
        setObjectAsync: async (id, obj) => {
            objects[id] = JSON.parse(JSON.stringify(obj));
        },
        setStateAsync: async (id, val, ack) => {
            states[id] = { val, ack };
            writes[id] = (writes[id] || 0) + 1;
        },
    };
}

/** `grace` in seconds, kept tiny so expiry can be observed without waiting */
function makeTracker(entries, grace = 60) {
    const adapter = makeAdapter();
    const tracker = new PresenceTracker(adapter, new DeviceStates(adapter), entries, grace);
    return { adapter, tracker };
}

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
});

describe('PresenceTracker', () => {
    it('ignores a row without a name or with an unusable address, and says so', () => {
        const { adapter, tracker } = makeTracker([
            { name: '', mac: PHONE },
            { name: 'Broken', mac: 'xx' },
            { name: 'Off', mac: PHONE, enabled: false },
            { name: 'Phone', mac: PHONE },
        ]);

        expect(tracker.size).to.equal(1);
        // The disabled row is a deliberate choice, so only the two unusable ones are reported
        expect(adapter.warnings).to.have.length(2);
    });

    it('ignores a second entry that would land on the same object id', () => {
        const { adapter, tracker } = makeTracker([
            { name: 'My Phone', mac: PHONE },
            { name: 'My.Phone', mac: 'aabbccddeeff' },
        ]);

        expect(tracker.size).to.equal(1);
        expect(adapter.warnings).to.have.length(1);
    });

    it('starts out away, because nothing is known before the first poll', async () => {
        const { adapter, tracker } = makeTracker([{ name: 'Phone', mac: PHONE }]);

        await tracker.start();
        tracker.stop();

        expect(adapter.objects['presence.Phone']).to.have.property('type', 'channel');
        expect(adapter.states['presence.Phone.connected'].val).to.equal(false);
        expect(adapter.states['presence.anyone'].val).to.equal(false);
        expect(adapter.states['presence.count'].val).to.equal(0);
        // Never seen means there is no timestamp to write
        expect(adapter.states).to.not.have.property('presence.Phone.lastSeen');
    });

    it('marks a device present whichever notation the router reports', async () => {
        const { adapter, tracker } = makeTracker([{ name: 'Phone', mac: 'A1B2C3D4E5F6' }]);
        await tracker.start();

        await tracker.report(ROUTER, [{ mac: PHONE, ssid: 'Home' }]);
        tracker.stop();

        expect(adapter.states['presence.Phone.connected'].val).to.equal(true);
        expect(adapter.states['presence.Phone.router'].val).to.equal(ROUTER);
        expect(adapter.states['presence.Phone.ssid'].val).to.equal('Home');
        expect(adapter.states['presence.Phone.lastSeen'].val).to.be.a('number');
        expect(adapter.states['presence.anyone'].val).to.equal(true);
        expect(adapter.states['presence.count'].val).to.equal(1);
    });

    it('keeps no trace of a station nobody asked about', async () => {
        const { adapter, tracker } = makeTracker([{ name: 'Phone', mac: PHONE }]);
        await tracker.start();

        await tracker.report(ROUTER, [{ mac: '00:11:22:33:44:55', ssid: 'Home' }]);
        tracker.stop();

        expect(Object.keys(adapter.objects).filter(id => id.includes('0011'))).to.have.length(0);
        expect(adapter.states['presence.Phone.connected'].val).to.equal(false);
        expect(adapter.states['presence.count'].val).to.equal(0);
    });

    it('holds a device present while it is merely missing from one poll', async () => {
        const { adapter, tracker } = makeTracker([{ name: 'Phone', mac: PHONE }]);
        await tracker.start();

        await tracker.report(ROUTER, [{ mac: PHONE, ssid: 'Home' }]);
        // A sleeping phone leaves the association list and comes back, which must not count as leaving
        await tracker.report(ROUTER, []);
        tracker.stop();

        expect(adapter.states['presence.Phone.connected'].val).to.equal(true);
    });

    it('turns a device away once the grace period has passed', async () => {
        // 50 ms, so the expiry can be observed without a clock of its own
        const { adapter, tracker } = makeTracker([{ name: 'Phone', mac: PHONE }], 0.05);
        await tracker.start();

        await tracker.report(ROUTER, [{ mac: PHONE, ssid: 'Home' }]);
        expect(adapter.states['presence.Phone.connected'].val).to.equal(true);

        await new Promise(resolve => setTimeout(resolve, 80));
        await tracker.report(ROUTER, []);
        tracker.stop();

        expect(adapter.states['presence.Phone.connected'].val).to.equal(false);
        expect(adapter.states['presence.anyone'].val).to.equal(false);
        // The timestamp stays: when it was last here is still the answer
        expect(adapter.states['presence.Phone.lastSeen'].val).to.be.a('number');
    });

    it('rewrites nothing but the timestamp while a device stays where it was', async () => {
        const { adapter, tracker } = makeTracker([{ name: 'Phone', mac: PHONE }]);
        await tracker.start();
        await tracker.report(ROUTER, [{ mac: PHONE, ssid: 'Home' }]);

        const before = { ...adapter.writes };
        // Far enough apart for the timestamp to differ, which is the one value that may change
        await new Promise(resolve => setTimeout(resolve, 5));
        await tracker.report(ROUTER, [{ mac: PHONE, ssid: 'Home' }]);
        tracker.stop();

        expect(adapter.writes['presence.Phone.connected']).to.equal(before['presence.Phone.connected']);
        expect(adapter.writes['presence.Phone.ssid']).to.equal(before['presence.Phone.ssid']);
        expect(adapter.writes['presence.anyone']).to.equal(before['presence.anyone']);
        expect(adapter.writes['presence.count']).to.equal(before['presence.count']);
        // Last seen is a new fact on every sighting
        expect(adapter.writes['presence.Phone.lastSeen']).to.equal(before['presence.Phone.lastSeen'] + 1);
    });

    it('does nothing at all without a configured device', async () => {
        const { adapter, tracker } = makeTracker([]);

        await tracker.start();
        await tracker.report(ROUTER, [{ mac: PHONE }]);
        tracker.stop();

        expect(tracker.size).to.equal(0);
        expect(Object.keys(adapter.states)).to.have.length(0);
    });
});
