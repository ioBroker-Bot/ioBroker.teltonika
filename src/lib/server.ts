import { Server } from 'node:net';
// @ts-expect-error no types
import mqtt from 'mqtt-connection';
import { SUPPORTED_TOPICS } from './topics';
import type DeviceStates from './states';
import { registerUsedPort, warnIfPortUsed } from './resources';
import type { TeltonikaAdapterConfig } from '../types';
const FORBIDDEN_CHARS = /[\][*,;'"`<>\\?]/g;

/**
 * How long a stored QoS 2 message waits for its release.
 *
 * The release follows the receipt within milliseconds, so anything still here after a minute belongs to a
 * router that was unplugged in the middle of the handshake and will never finish it.
 */
const QOS2_ABANDONED_AFTER = 60000;

interface MQTTPacket {
    qos: 0 | 1 | 2;
    topic: string;
    payload: Buffer;
    messageId: number;
    retain: boolean;
}

type StateState = 'requested' | 'received' | 'ignored';

/** An inbound QoS 2 message that is stored until its release arrives, with the time it was taken in */
interface MQTTPacketQos2 extends MQTTPacket {
    ts: number;
}

interface MQTTClient {
    __secret: string;
    _will: string;
    id: string;
    iobId: string;
    /**
     * Inbound QoS 2 messages waiting for their release. Nothing else is stored, because every publish of the
     * broker itself goes out with QoS 0.
     */
    _messages: MQTTPacketQos2[];
    on: (event: string, handler: (arg?: any) => void) => void;
    connack: (options: { returnCode: number; sessionPresent?: boolean }) => void;
    destroy: () => void;
    puback: (options: { messageId: number }) => void;
    pubrel: (options: { messageId: number }) => void;
    pubrec: (options: { messageId: number }) => void;
    pubcomp: (options: { messageId: number }) => void;
    suback: (options: { messageId: number; granted: (0 | 1 | 2 | 128)[] }) => void;
    unsuback: (options: { messageId: number }) => void;
    pingresp: () => void;
    publish: (
        packet: { topic: string; payload: string; qos: 0 | 1 | 2; retain?: boolean; messageId: number },
        cb?: () => void,
    ) => void;
    stream: {
        remoteAddress: string;
        remotePort: number;
    };
    states: {
        [topic: string]: StateState;
    };
    routerId?: string;
}

export default class MQTTServer {
    private readonly mappingClients: { [iobId: string]: string } = {};

    private readonly server: Server;
    private readonly clients: { [id: string]: MQTTClient } = {};
    private pollInterval: NodeJS.Timeout | null = null;

    private config: TeltonikaAdapterConfig;
    private adapter: ioBroker.Adapter;
    private readonly states: DeviceStates;
    private messageId = 1;
    /** Set on unload, which can come while the start still waits for js-controller */
    private destroyed = false;

    constructor(adapter: ioBroker.Adapter, states: DeviceStates) {
        this.config = adapter.config as TeltonikaAdapterConfig;
        this.server = new Server();
        this.adapter = adapter;
        this.states = states;
        this.start().catch(error => this.adapter.log.error(`Cannot start broker: ${error}`));
    }

    async start(): Promise<void> {
        this.config.timeout = !this.config.timeout ? 300 : parseInt(this.config.timeout as string, 10);
        this.config.defaultQoS = parseInt(this.config.defaultQoS as string, 10) || 0;
        this.config.pollInterval = parseInt(this.config.pollInterval as string, 10) || 5000;
        this.config.port = parseInt(this.config.port as string, 10) || 1883;

        this.server.on('connection', (stream: any): void => {
            const client: MQTTClient = mqtt(stream);
            // Store unique connection identifier
            client.__secret = `${Date.now()}_${Math.round(Math.random() * 10000)}`;

            // client connected
            client.on(
                'connect',
                async (options: {
                    clientId: string;
                    password: string;
                    username: string;
                    will?: string;
                }): Promise<void> => {
                    // acknowledge the "connect" packet
                    client.id = options.clientId;
                    client.iobId = client.id.replace(FORBIDDEN_CHARS, '_');
                    this.mappingClients[client.iobId] = client.id;

                    // get possible an old client
                    const oldClient = this.clients[client.id];

                    if (this.config.user) {
                        if (options.password) {
                            options.password = options.password.toString();
                        }
                        if (this.config.user !== options.username || this.config.password !== options.password) {
                            this.adapter.log.warn(`Client [${client.id}] has invalid password or username`);
                            client.connack({ returnCode: 4 });
                            if (oldClient) {
                                // delete existing client
                                delete this.clients[client.id];
                                await this.updateAlive(oldClient, false);
                                await this.updateClients();
                                oldClient.destroy();
                            }
                            client.destroy();
                            return;
                        }
                    }

                    if (oldClient) {
                        this.adapter.log.info(
                            `Client [${client.id}] reconnected. Old secret ${this.clients[client.id].__secret} ==> New secret ${client.__secret}`,
                        );
                        // need to destroy the old client

                        if (client.__secret !== this.clients[client.id].__secret) {
                            // it is another socket!!
                            // It was following situation:
                            // - old connection was active
                            // - new connection is on the same TCP
                            // Just forget him
                            // oldClient.destroy();
                        }
                    } else {
                        this.adapter.log.info(`Client [${client.id}] connected with secret ${client.__secret}`);
                    }

                    client._messages ||= [];
                    client.states ||= {};

                    client.connack({ returnCode: 0, sessionPresent: true });
                    this.clients[client.id] = client;
                    await this.updateClients();

                    await this.readId(client);
                },
            );

            // timeout idle streams after 5 minutes
            if (this.config.timeout) {
                stream.setTimeout((this.config.timeout as number) * 1000);
            }

            // connection error handling
            client.on('close', had_error => this.clientClose(client, had_error ? 'closed because of error' : 'closed'));
            client.on('error', e => this.clientClose(client, e));
            client.on('disconnect', () => this.clientClose(client, 'disconnected'));
            // stream timeout
            stream.on('timeout', () => this.clientClose(client, 'timeout'));

            client.on('publish', async (packet: MQTTPacket): Promise<void> => {
                if (this.clients[client.id] && client.__secret !== this.clients[client.id].__secret) {
                    if (!this.config.ignorePings) {
                        this.adapter.log.warn(
                            `Old client ${client.id} with secret ${client.__secret} sends publish. Ignore! Actual secret is ${this.clients[client.id].__secret}`,
                        );
                    }
                    return;
                }

                if (packet.qos === 1) {
                    // send PUBACK to a client
                    client.puback({ messageId: packet.messageId });
                } else if (packet.qos === 2) {
                    const pack = client._messages?.find(e => e.messageId === packet.messageId);
                    if (pack) {
                        // A repeat of a message that is still waiting for its pubrel. The payload must not be
                        // handled twice — that is what QoS 2 is for — but the id has to be acknowledged again:
                        // a router that gets no pubrec repeats the publish for as long as it lives.
                        this.adapter.log.debug(
                            `Client [${client.id}] repeated message ID ${packet.messageId}, answered with pubrec`,
                        );
                        client.pubrec({ messageId: packet.messageId });
                        return;
                    }
                    this.dropAbandonedMessages(client);
                    client._messages.push({ ...packet, ts: Date.now() });

                    client.pubrec({ messageId: packet.messageId });
                    return;
                }

                await this.receivedTopic(packet, client);
            });

            // response for QoS2
            client.on('pubrec', packet => {
                if (this.clients[client.id] && client.__secret !== this.clients[client.id].__secret) {
                    !this.config.ignorePings &&
                        this.adapter.log.warn(
                            `Old client ${client.id} with secret ${client.__secret} sends pubrec. Ignore! Actual secret is ${this.clients[client.id].__secret}`,
                        );
                    return;
                }

                let pos = null;
                // remove this message from queue
                client._messages?.forEach((e, i) => {
                    if (e.messageId === packet.messageId) {
                        pos = i;
                        return false;
                    }
                });
                if (pos !== null) {
                    client.pubrel({ messageId: packet.messageId });
                } else {
                    this.adapter.log.warn(
                        `Client [${client.id}] received pubrec on ${client.id} for unknown message ID: ${packet.messageId}`,
                    );
                }
            });

            // response for QoS2
            client.on('pubcomp', packet => {
                if (this.clients[client.id] && client.__secret !== this.clients[client.id].__secret) {
                    !this.config.ignorePings &&
                        this.adapter.log.warn(
                            `Old client ${client.id} with secret ${client.__secret} sends pubcomp. Ignore! Actual secret is ${this.clients[client.id].__secret}`,
                        );
                    return;
                }

                let pos = null;
                // remove this message from queue
                client._messages?.forEach((e, i) => {
                    if (e.messageId === packet.messageId) {
                        pos = i;
                        return false;
                    }
                });
                if (pos !== null) {
                    client._messages?.splice(pos, 1);
                } else {
                    this.adapter.log.warn(
                        `Client [${client.id}] received pubcomp for unknown message ID: ${packet.messageId}`,
                    );
                }
            });

            // response for QoS2
            client.on('pubrel', async (packet): Promise<void> => {
                if (!client._messages) {
                    return;
                }
                if (this.clients[client.id] && client.__secret !== this.clients[client.id].__secret) {
                    !this.config.ignorePings &&
                        this.adapter.log.warn(
                            `Old client ${client.id} with secret ${client.__secret} sends pubrel. Ignore! Actual secret is ${this.clients[client.id].__secret}`,
                        );
                    return;
                }

                let pos = null;
                // remove this message from queue
                client._messages?.forEach((e, i) => {
                    if (e.messageId === packet.messageId) {
                        pos = i;
                        return false;
                    }
                });

                if (pos !== null) {
                    client.pubcomp({ messageId: packet.messageId });

                    await this.receivedTopic(client._messages[pos], client);
                    client._messages?.splice(pos, 1);
                } else {
                    // Nothing stored under that id: either the pubcomp of the first attempt was lost, or the
                    // router reconnected and replayed what its session still held. A pubrel is answered with a
                    // pubcomp either way — staying silent is what makes a router repeat it forever, and that
                    // is what floods the log. There is nothing to deliver here: the payload was handled on the
                    // first pubrel, or it never arrived at all.
                    this.adapter.log.debug(
                        `Client [${client.id}] sent pubrel for the unknown messageId ${packet.messageId}, answered with pubcomp`,
                    );
                    client.pubcomp({ messageId: packet.messageId });
                }
            });

            // response for QoS1
            client.on('puback', packet => {
                if (this.clients[client.id] && client.__secret !== this.clients[client.id].__secret) {
                    !this.config.ignorePings &&
                        this.adapter.log.warn(
                            `Old client ${client.id} with secret ${client.__secret} sends puback. Ignore! Actual secret is ${this.clients[client.id].__secret}`,
                        );
                    return;
                }

                // remove this message from queue
                let pos = null;
                // remove this message from queue
                client._messages?.forEach((e, i) => {
                    if (e.messageId === packet.messageId) {
                        pos = i;
                        return false;
                    }
                });

                if (pos !== null) {
                    this.adapter.log.debug(
                        `Client [${client.id}] received puback for ${client.id} message ID: ${packet.messageId}`,
                    );
                    client._messages?.splice(pos, 1);
                } else {
                    this.adapter.log.warn(
                        `Client [${client.id}] received puback for unknown message ID: ${packet.messageId}`,
                    );
                }
            });

            client.on('unsubscribe', packet => {
                if (this.clients[client.id] && client.__secret !== this.clients[client.id].__secret) {
                    !this.config.ignorePings &&
                        this.adapter.log.warn(
                            `Old client ${client.id} with secret ${client.__secret} sends unsubscribe. Ignore! Actual secret is ${this.clients[client.id].__secret}`,
                        );
                    return;
                }

                client.unsuback({ messageId: packet.messageId });
            });

            client.on(
                'subscribe',
                (packet: {
                    messageId: number;
                    subscriptions: {
                        qos: 0 | 1 | 2;
                    }[];
                }): void => {
                    if (this.clients[client.id] && client.__secret !== this.clients[client.id].__secret) {
                        if (!this.config.ignorePings) {
                            this.adapter.log.warn(
                                `Old client ${client.id} with secret ${client.__secret} sends subscribe. Ignore! Actual secret is ${this.clients[client.id].__secret}`,
                            );
                        }
                        return;
                    }

                    // just confirm the request.
                    const granted = packet.subscriptions.map(subs => subs.qos);

                    client.suback({ granted, messageId: packet.messageId });
                },
            );

            client.on('pingreq', (/*packet*/) => {
                if (this.clients[client.id] && client.__secret !== this.clients[client.id].__secret) {
                    !this.config.ignorePings &&
                        this.adapter.log.warn(
                            `Old client ${client.id} with secret ${client.__secret} sends pingreq. Ignore! Actual secret is ${this.clients[client.id].__secret}`,
                        );
                    return;
                }

                this.adapter.log.debug(`Client [${client.id}] pingreq`);
                client.pingresp();
            });
        });

        this.server.on('error', err => this.adapter.log.error(`Can not start Server ${err}`));

        // Update connection state
        await this.updateClients();

        // Ask js-controller (>= 8) first, so a failing listen can name the instance that holds the port
        const port = this.config.port;
        await warnIfPortUsed(this.adapter, 'tcpPort', port, this.config.bind, 'MQTT server');
        if (this.destroyed) {
            return;
        }

        // to start
        this.server.listen(port, this.config.bind, () => {
            this.adapter.log.info(`Starting MQTT ${this.config.user ? 'authenticated ' : ''} server on port ${port}`);
            void registerUsedPort(this.adapter, 'tcpPort', port, this.config.bind);
        });
    }

    /**
     * Forget QoS 2 messages whose release never came, so the list cannot grow for the life of a connection.
     *
     * Pruned when the next such message arrives rather than on a timer of its own: that is the only moment the
     * list can grow, which bounds it by the publish rate of the client, and it saves a timer that would have to
     * be cleared on unload. A dropped message is one the router gave up on as well — it was never written to a
     * state, because that happens on the release.
     */
    private dropAbandonedMessages(client: MQTTClient): void {
        if (!client._messages?.length) {
            return;
        }
        const deadline = Date.now() - QOS2_ABANDONED_AFTER;
        const kept = client._messages.filter(message => message.ts > deadline);
        if (kept.length !== client._messages.length) {
            this.adapter.log.debug(
                `Client [${client.id}] dropped ${client._messages.length - kept.length} QoS 2 message(s) that were never released`,
            );
            client._messages = kept;
        }
    }

    readId(client: MQTTClient): Promise<void> {
        return new Promise<void>(resolve =>
            client.publish(
                { topic: 'router/get', payload: 'id', qos: 0, retain: false, messageId: this.messageId++ },
                () => resolve(),
            ),
        );
    }

    private async polling(): Promise<void> {
        for (const clientId in this.clients) {
            if (this.clients[clientId].routerId) {
                // poll all data
                for (const topic in SUPPORTED_TOPICS) {
                    if (!this.clients[clientId].states[topic] || this.clients[clientId].states[topic] === 'received') {
                        this.clients[clientId].states[topic] ||= 'requested';
                        await new Promise<void>(resolve =>
                            this.clients[clientId].publish(
                                {
                                    topic: 'router/get',
                                    payload: topic,
                                    qos: 0,
                                    messageId: this.messageId++,
                                },
                                () => resolve(),
                            ),
                        );
                    }
                }
            }
        }
    }

    startPolling(): void {
        if (!this.pollInterval) {
            console.log(`${new Date().toISOString()}! START POLLING!`);
            this.polling().catch(error => this.adapter.log.error(`Polling: ${error}`));
            this.pollInterval = setInterval(
                async (): Promise<void> => {
                    console.log(`${new Date().toISOString()}! POLLING!`);
                    await this.polling();
                },
                (this.config.pollInterval as number) || 5000,
            );
        }
    }

    stopPolling(): void {
        if (this.pollInterval) {
            if (Object.keys(this.clients).length === 0) {
                clearInterval(this.pollInterval);
                this.pollInterval = null;
            }
        }
    }

    async destroy(): Promise<void> {
        this.destroyed = true;
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }

        if (this.server) {
            for (const id in this.clients) {
                await this.updateAlive(this.clients[id], false);
            }
            // to release all resources
            await new Promise<void>(resolve => this.server.close(() => resolve()));
        }
    }

    private async updateClients(): Promise<void> {
        await this.states.setConnections('mqtt', Object.keys(this.clients));
    }

    private async updateAlive(client: MQTTClient, alive: boolean): Promise<void> {
        // Before the router has answered `router/id` there is no device to mark alive yet
        if (client.routerId && this.states.claim(client.routerId, 'mqtt')) {
            await this.states.setAlive(client.routerId, alive);
        }
    }

    private async receivedTopic(packet: MQTTPacket, client: MQTTClient): Promise<void> {
        if (!packet) {
            return this.adapter.log.warn(`Empty packet received: ${JSON.stringify(packet)}`);
        }

        // update alive state
        await this.updateAlive(client, true);

        const val = packet.payload.toString('utf8');
        this.adapter.log.debug(`Client [${client.id}] received: ${packet.topic} = ${val}`);
        if (packet.topic === 'router/id') {
            client.routerId = val;
            if (this.states.claim(val, 'mqtt')) {
                await this.states.ensureDevice(val, client.id);
            }
            this.startPolling();
        } else {
            const name = packet.topic.split('/').pop() || '';
            if (SUPPORTED_TOPICS[name] && client.routerId) {
                client.states[name] = 'received';
                // Skipped when the same device is polled over SNMP, so the two transports cannot fight
                if (this.states.claim(client.routerId, 'mqtt')) {
                    await this.states.applyValue(client.routerId, name, val);
                }
            } else {
                this.adapter.log.warn(`Received unknown variable "${packet.topic}": ${packet.payload.toString()}`);
            }
        }
    }

    private async clientClose(client: MQTTClient, reason?: string): Promise<void> {
        if (!client) {
            return;
        }

        try {
            if (this.clients[client.id] && client.__secret === this.clients[client.id].__secret) {
                this.adapter.log.info(`Client [${client.id}] connection closed: ${reason}`);
                await this.updateAlive(client, false);
                if (client.routerId) {
                    this.states.release(client.routerId, 'mqtt');
                }
                delete this.clients[client.id];
                await this.updateClients();
            }

            client.destroy();
        } catch (e) {
            this.adapter.log.warn(`Client [${client.id}] cannot close client: ${e}`);
        }
        this.stopPolling();
    }
}
