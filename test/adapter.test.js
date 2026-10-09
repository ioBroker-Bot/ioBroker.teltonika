/* jshint -W097 */
/* jshint strict: true */
/* jslint node: true */
/* jslint esversion: 6 */
'use strict';

const setup = require('@iobroker/legacy-testing');

let objects = null;
let states = null;
let mqttClientEmitter = null;
let connected = false;

let routerConnected = false;
let brokerStarted = false;
const SERIAL = '123456780';

const SUPPORTED_TOPICS = {
    temperature: '366',
    operator: 'o2',
    signal: '50',
    network: 'Roaming',
    connection: '2G',
    wan: '1.1.1.1',
    uptime: '1234',
    name: 'TestRouter',
    digital1: 'N/A',
    digital2: '1',
    analog: '1234',
    pin2: '0',
    pin3: '1',
    pin4: '2',
};
function encryptLegacy(key, value) {
    let result = '';
    for (let i = 0; i < value.length; i++) {
        result += String.fromCharCode(key[i % key.length].charCodeAt(0) ^ value.charCodeAt(i));
    }
    return result;
}

function startClients(_done) {
    // start mqtt client
    const MqttClient = require('./lib/mqttClient.js');

    // Start a client to emit topics
    mqttClientEmitter = new MqttClient(
        connected => {
            // on connected
            if (connected) {
                console.log('Test MQTT Emitter is connected to MQTT broker');
                routerConnected = true;
                if (_done && brokerStarted && routerConnected) {
                    _done();
                    _done = null;
                }
            }
        },
        (topic, message) => {
            console.log(`${new Date().toISOString()} emitter received ${topic}: ${message.toString()}`);
            const payload = message.toString();
            // on receive
            if (topic === 'router/get') {
                if (payload === 'id') {
                    mqttClientEmitter.publish('router/id', SERIAL);
                } else if (SUPPORTED_TOPICS[payload]) {
                    mqttClientEmitter.publish(`router/${SERIAL}/${payload}`, SUPPORTED_TOPICS[payload]);
                } else {
                    throw new Error(`Unknown topic request: ${topic} with payload ${payload}`);
                }
            }
        },
        { name: 'Emitter*1', user: 'user', pass: 'pass1', url: '127.0.0.1:1885' },
    );
}

function checkConnection(value, done, counter) {
    counter ||= 0;
    if (counter > 20) {
        done && done(`Cannot check ${value}`);
        return;
    }

    states.getState('teltonika.0.info.connection', (err, state) => {
        if (err) {
            console.error(err);
        }
        if (
            typeof state?.val === 'string' &&
            ((!value && state.val === '') || (value && state.val.split(',').includes(value)))
        ) {
            connected = value;
            done();
        } else {
            setTimeout(() => checkConnection(value, done, counter + 1), 1000);
        }
    });
}

describe('Teltonika server: Test mqtt server', () => {
    before('Teltonika server: Start js-controller', function (_done) {
        //
        this.timeout(600000); // because of the first installation from npm
        setup.adapterStarted = false;

        setup.setupController(async () => {
            let systemConfig = await setup.getObject('system.config');
            if (!systemConfig?.native?.secret) {
                systemConfig ||= { common: {}, native: {} };
                systemConfig.native ||= {};
                systemConfig.native.secret = '12345';
                await setup.setObject('system.config', systemConfig);
            }
            // setupController packs and uploads the adapter but never adds an instance, so on a fresh database
            // system.adapter.teltonika.0 is missing and getAdapterConfig() returns an empty object. Guarded,
            // because "iobroker add" allocates the next free number: calling it unconditionally would leave a
            // new instance behind on every run.
            let config = await setup.getAdapterConfig();
            if (!config?.common) {
                await setup.installAdapter();
                config = await setup.getAdapterConfig();
            }
            // enable adapter
            config.common.enabled = true;
            config.common.loglevel = 'debug';
            config.native.user = 'user';
            config.native.password = encryptLegacy(systemConfig.native.secret, 'pass1');

            await setup.setAdapterConfig(config.common, config.native);

            // Pass the explicit `isStartAdapter` flag: with a single function argument legacy-testing 3.x takes it
            // for an object change handler and never calls back, which hangs this hook until mocha times out.
            setup.startController(true, (_objects, _states) => {
                objects = _objects;
                states = _states;
                brokerStarted = true;
                if (_done && brokerStarted && routerConnected) {
                    _done();
                    _done = null;
                }
            });
        });

        startClients(_done);
    });

    it('Teltonika Server: Check if connected to MQTT broker', done => {
        if (!connected) {
            checkConnection('Emitter*1', done);
        } else {
            done();
        }
    }).timeout(2000);

    it('Teltonika Server: It must see temperature and other values', async () => {
        await new Promise(resolve => setTimeout(resolve, 500));
        let state = await states.getState(`teltonika.0.${SERIAL}.temperature`);
        if (state.val !== parseInt(SUPPORTED_TOPICS.temperature, 10) / 10) {
            throw new Error(`Invalid temperature: ${state.val}`);
        }
        state = await states.getState(`teltonika.0.${SERIAL}.signal`);
        if (state.val !== parseInt(SUPPORTED_TOPICS.signal, 10)) {
            throw new Error(`Invalid signal: ${state.val}`);
        }
        state = await states.getState(`teltonika.0.${SERIAL}.digital1`);
        if (state.val !== null) {
            throw new Error(`Invalid digital1: ${state.val}`);
        }
        state = await states.getState(`teltonika.0.${SERIAL}.digital2`);
        if (state.val !== true) {
            throw new Error(`Invalid digital2: ${state.val}`);
        }
        state = await states.getState(`teltonika.0.${SERIAL}.operator`);
        if (state.val !== SUPPORTED_TOPICS.operator) {
            throw new Error(`Invalid operator: ${state.val}`);
        }
    }).timeout(7000);

    // give time to a client to receive all messages
    it('wait', done => {
        setTimeout(() => done(), 1000);
    }).timeout(4000);

    it('Teltonika Server: check reconnection', done => {
        mqttClientEmitter.stop();
        checkConnection('', error => {
            if (error) {
                throw new Error(error);
            }

            if (error) {
                throw new Error(error);
            }
            startClients();
            checkConnection('Emitter*1', error => {
                if (error) {
                    throw new Error(error);
                }
                done();
            });
        });
    }).timeout(1000000);

    // A pubrel the broker has no record of — a lost pubcomp, or a session the router replayed after a
    // reconnect — must still be answered. Without a pubcomp the router repeats the pubrel for as long as it
    // lives, which floods the log and never resolves.
    it('Teltonika Server: answers a pubrel with an unknown messageId', function (_done) {
        const net = require('node:net');
        const mqttConnection = require('mqtt-connection');
        const MESSAGE_ID = 54321;

        const stream = net.createConnection({ host: '127.0.0.1', port: 1885 });
        const client = mqttConnection(stream);
        let finished = false;
        let timer = null;
        const finish = error => {
            if (finished) {
                return;
            }
            finished = true;
            if (timer) {
                clearTimeout(timer);
            }
            try {
                client.destroy();
            } catch {
                // the socket may already be gone
            }
            _done(error);
        };
        timer = setTimeout(() => finish(new Error('no pubcomp for a pubrel with an unknown messageId')), 5000);

        stream.on('connect', () =>
            client.connect({
                clientId: 'PubrelProbe',
                protocolId: 'MQTT',
                protocolVersion: 4,
                username: 'user',
                password: 'pass1',
                keepalive: 60,
                clean: true,
            }),
        );
        client.on('connack', packet => {
            if (packet.returnCode !== 0) {
                finish(new Error(`broker refused the probe: ${packet.returnCode}`));
                return;
            }
            client.pubrel({ messageId: MESSAGE_ID });
        });
        client.on('pubcomp', packet =>
            finish(
                packet.messageId === MESSAGE_ID
                    ? undefined
                    : new Error(`pubcomp for ${packet.messageId} instead of ${MESSAGE_ID}`),
            ),
        );
        client.on('error', error => finish(error));
        stream.on('error', error => finish(error));
    }).timeout(15000);

    after('Teltonika Server: Stop js-controller', function (_done) {
        // let FUNCTION and not => here
        this.timeout(5000);
        mqttClientEmitter.stop();
        setup.stopController(() => _done());
    });
});
