// What the presence widgets (`TeltonikaPerson`, `TeltonikaPresence`) share: the instance, the values of the
// states, the colors and the two symbols.
//
// The same helpers live in `Generic.tsx`/`format.ts` of the vis-2 widgets of ioBroker.tr-064, which read the same
// object tree below `<instance>.presence`.

import type React from 'react';
import { alpha, SvgIcon, type SvgIconProps, type Theme } from '@mui/material';
import { I18n } from '@iobroker/gui-components';

import type { PresenceSocket } from './presenceApi';

export const ADAPTER_NAME = 'teltonika';

/**
 * `teltonika.<n>` of the attribute `instance`.
 *
 * The attribute holds `teltonika.0`; `0` and `system.adapter.teltonika.0` are accepted too. Anything else is the
 * first instance.
 *
 * @param raw value of the attribute
 */
export function instanceIdOf(raw: unknown): string {
    const value = typeof raw === 'string' || typeof raw === 'number' ? String(raw).trim() : '';
    const match = value.match(/^(?:system\.adapter\.)?(?:teltonika\.)?(\d+)$/);
    return `${ADAPTER_NAME}.${match ? match[1] : '0'}`;
}

/** The vis-2 socket: it has everything `loadPersons()` and `loadPresenceHistory()` need */
export function presenceSocketOf(socket: unknown): PresenceSocket {
    return socket as PresenceSocket;
}

/** A widget setting as a string; a new widget's fields are simply absent. */
export function stringData(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

/** The language of vis-2 */
export function language(): string {
    return I18n.getLanguage() || 'en';
}

/**
 * Color of secondary texts. Not `palette.text.secondary`: the dark theme of ioBroker sets it to white, the same as
 * the primary text, and the widgets would lose their hierarchy.
 *
 * @param theme MUI theme of vis-2
 */
export function muted(theme: Theme): string {
    return alpha(theme.palette.text.primary, 0.64);
}

/**
 * Color of absent persons and unknown things, see `muted()`
 *
 * @param theme MUI theme of vis-2
 */
export function faint(theme: Theme): string {
    return alpha(theme.palette.text.primary, 0.38);
}

/** `true`/`false` of a state value, `undefined` if the state does not exist */
export function toBool(value: ioBroker.StateValue | undefined): boolean | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (typeof value === 'string') {
        return value === 'true' || value === '1' || value === 'on';
    }
    return !!value;
}

/** A number of a state value, `undefined` if the state does not exist or is not a number */
export function toNumber(value: ioBroker.StateValue | undefined): number | undefined {
    if (value === undefined || value === null || value === '') {
        return undefined;
    }
    const num = Number(value);
    return Number.isFinite(num) ? num : undefined;
}

/** A text of a state value, `''` if the state does not exist */
export function toText(value: ioBroker.StateValue | undefined): string {
    return value === undefined || value === null ? '' : String(value).trim();
}

/** Value of a state, `undefined` while it was not read or if it does not exist */
export type StateValues = Record<string, ioBroker.StateValue | undefined>;

/** The part of the vis-2 socket which `StateWatcher` uses */
export interface WatchSocket {
    subscribeState(ids: string[], cb: ioBroker.StateChangeHandler): Promise<void>;
    unsubscribeState(ids: string[], cb: ioBroker.StateChangeHandler): void;
}

/**
 * Subscribes a list of states and keeps their values.
 *
 * A state which does not exist never calls back, so its value stays `undefined` - the widgets show only what is
 * there (e.g. `presence.guests.count` without guest SSIDs).
 */
export class StateWatcher {
    private ids: string[] = [];

    private readonly values: StateValues = {};

    private stopped = false;

    constructor(
        private readonly socket: WatchSocket,
        private readonly onChange: (values: StateValues) => void,
    ) {}

    /**
     * Subscribes exactly these IDs, the ones which are not in the list any more are unsubscribed
     *
     * @param ids full state IDs
     */
    watch(ids: string[]): void {
        const wanted = [...new Set(ids)];
        if (wanted.length === this.ids.length && wanted.every(id => this.ids.includes(id))) {
            return;
        }
        const removed = this.ids.filter(id => !wanted.includes(id));
        const added = wanted.filter(id => !this.ids.includes(id));
        this.ids = wanted;
        this.stopped = false;

        if (removed.length) {
            this.socket.unsubscribeState(removed, this.onState);
            removed.forEach(id => delete this.values[id]);
            this.onChange({ ...this.values });
        }
        if (added.length) {
            this.socket
                .subscribeState(added, this.onState)
                .catch((e: unknown) => console.warn(`Cannot subscribe the presence states: ${String(e)}`));
        }
    }

    /** Unsubscribes everything, `onChange` is not called any more */
    stop(): void {
        this.stopped = true;
        if (this.ids.length) {
            this.socket.unsubscribeState(this.ids, this.onState);
            this.ids = [];
        }
    }

    private onState = (id: string, state: ioBroker.State | null | undefined): void => {
        if (this.stopped || !this.ids.includes(id)) {
            return;
        }
        const value = state && state.val !== null ? state.val : undefined;
        if (id in this.values && this.values[id] === value) {
            return;
        }
        this.values[id] = value;
        this.onChange({ ...this.values });
    };
}

// The symbols of `@mui/icons-material` (`Person`, `PersonOff`): the package is not shared by vis-2, and two
// paths are not worth bundling it.

/** A present person */
export function IconPerson(props: SvgIconProps): React.JSX.Element {
    return (
        <SvgIcon {...props}>
            <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4m0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4" />
        </SvgIcon>
    );
}

/** An absent person */
export function IconAway(props: SvgIconProps): React.JSX.Element {
    return (
        <SvgIcon {...props}>
            <path d="M8.65 5.82C9.36 4.72 10.6 4 12 4c2.21 0 4 1.79 4 4 0 1.4-.72 2.64-1.82 3.35zM20 17.17c-.02-1.1-.63-2.11-1.61-2.62-.54-.28-1.13-.54-1.77-.76zm1.19 4.02L2.81 2.81 1.39 4.22l8.89 8.89c-1.81.23-3.39.79-4.67 1.45-1 .51-1.61 1.54-1.61 2.66V20h13.17l2.61 2.61z" />
        </SvgIcon>
    );
}
