/**
 * Exclusive-resource registry of js-controller 8: the ports the adapter listens on are reported there, so the
 * user sees them as occupied and another instance can be warned before it tries to take them.
 *
 * `common.declareUsedResources` is set, because js-controller would otherwise derive a single `tcpPort` from
 * `native.port` and never know about the UDP port of the trap receiver. The installed types and older
 * controllers do not have the API, so it is probed at runtime.
 */

export type PortType = 'tcpPort' | 'udpPort';

interface PortResource {
    port: number;
    bind?: string;
}

interface ResourceRegistry {
    registerUsedResource(type: PortType, data: PortResource): Promise<void>;
    checkUsedResource?(type: PortType, data?: Partial<PortResource>): Promise<{ instance: string }[]>;
}

function registryOf(adapter: ioBroker.Adapter): ResourceRegistry | null {
    const registry = adapter as unknown as ResourceRegistry;
    return typeof registry.registerUsedResource === 'function' ? registry : null;
}

/** An unset or wildcard address is the registry's default anyway */
function resourceOf(port: number, bind?: string): PortResource {
    return bind && bind !== '0.0.0.0' ? { port, bind } : { port };
}

/**
 * Warn if another instance holds the port. Call it before listening: afterwards the operating system has decided
 * the conflict, and this could only explain it. An empty answer does not promise the port is free — the registry
 * only knows what adapters declare.
 */
export async function warnIfPortUsed(
    adapter: ioBroker.Adapter,
    type: PortType,
    port: number,
    bind: string | undefined,
    what: string,
): Promise<void> {
    const registry = registryOf(adapter);
    if (!registry?.checkUsedResource) {
        return;
    }
    try {
        const holders = await registry.checkUsedResource(type, resourceOf(port, bind));
        if (holders.length) {
            adapter.log.warn(
                `Port ${port} is already used by ${holders.map(h => h.instance).join(', ')}. The ${what} will probably not start.`,
            );
        }
    } catch (error) {
        adapter.log.debug(`Cannot check if port ${port} is free: ${error instanceof Error ? error.message : error}`);
    }
}

/** Report a port the adapter now listens on. The host drops the entries of an instance when it stops. */
export async function registerUsedPort(
    adapter: ioBroker.Adapter,
    type: PortType,
    port: number,
    bind?: string,
): Promise<void> {
    const registry = registryOf(adapter);
    if (!registry) {
        return;
    }
    try {
        await registry.registerUsedResource(type, resourceOf(port, bind));
    } catch (error) {
        adapter.log.warn(`Cannot register port ${port} as used: ${error instanceof Error ? error.message : error}`);
    }
}
