// The persons of the presence detection as a vis-2 widget: present or away, for how long, and when they came or
// left - the counterpart of the persons mode of the presence widget of ioBroker.tr-064, which reads the same object
// tree below `<instance>.presence`.
//
// Optionally only the persons of one group, only the present ones, or the present ones first; the number of guests
// (`presence.guests.count`, the stations of the guest SSIDs) is shown in the summary line when the instance has it.

import React from 'react';
import { alpha, Box, CircularProgress } from '@mui/material';
import { I18n } from '@iobroker/gui-components';
import type { RxRenderWidgetProps, RxWidgetInfo, VisRxWidgetProps, VisRxWidgetState } from '@iobroker/types-vis-2';
import type VisRxWidget from '@iobroker/types-vis-2/visRxWidget';

import PresenceField from './PresenceField';
import {
    faint,
    IconAway,
    IconPerson,
    instanceIdOf,
    language,
    muted,
    presenceSocketOf,
    StateWatcher,
    stringData,
    toBool,
    toNumber,
    type StateValues,
} from './presence';
import { formatDuration, formatEventTime, loadPersons, PERSON_STATES } from './presenceApi';

interface TeltonikaPresenceRxData {
    instance: string;
    /** only the persons of this group, empty = all */
    group: string;
    /** the number of stations in the guest networks */
    showGuests: boolean;
    onlyActive: boolean;
    activeFirst: boolean;
    noCard: boolean;
    widgetTitle: string;
}

/** One person, a channel below `presence.persons` */
interface PresencePerson {
    /** e.g. `teltonika.0.presence.persons.Anna` */
    id: string;
    name: string;
}

interface TeltonikaPresenceState extends VisRxWidgetState {
    /** `null` while the persons are read */
    persons: PresencePerson[] | null;
    /** Values of the person states, by full ID (not `values`, that one belongs to vis-2) */
    presence: StateValues;
}

/** The states of a person which are shown */
const LIST_STATES = [
    PERSON_STATES.present,
    PERSON_STATES.lastArrival,
    PERSON_STATES.lastDeparture,
    PERSON_STATES.presentSince,
    PERSON_STATES.absentSince,
] as const;

/** One row of the list */
interface PresenceRow extends PresencePerson {
    active: boolean | undefined;
    /** the second line */
    info: string;
    /** right of the row: when the person came or left */
    time: string;
}

const ellipsis: React.CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };

export default class TeltonikaPresence extends (window.visRxWidget as typeof VisRxWidget)<
    TeltonikaPresenceRxData,
    TeltonikaPresenceState
> {
    private watcher: StateWatcher | null = null;

    private ticker: ReturnType<typeof setInterval> | null = null;

    constructor(props: VisRxWidgetProps) {
        super(props);
        this.state = {
            ...this.state,
            persons: null,
            presence: {},
        };
    }

    public static getI18nPrefix(): string {
        return 'telt_';
    }

    public static getWidgetInfo(): RxWidgetInfo {
        return {
            id: 'tplTeltonikaPresence',
            visSet: 'teltonika',
            visSetLabel: 'set_label',
            visSetColor: '#0a5ea8',
            visName: 'Teltonika presence',
            visWidgetLabel: 'TeltonikaPresence',
            visAttrs: [
                {
                    name: 'common',
                    fields: [
                        {
                            name: 'instance',
                            label: 'instance',
                            type: 'instance',
                            adapter: 'teltonika',
                            default: 'teltonika.0',
                        },
                        {
                            name: 'group',
                            label: 'group',
                            tooltip: 'group_tooltip',
                            type: 'custom',
                            // The groups of the persons the instance has, instead of typing one
                            component: (_field, data, setData, props) => (
                                <PresenceField
                                    kind="group"
                                    socket={presenceSocketOf(props.context.socket)}
                                    instance={data.instance}
                                    value={stringData(data.group)}
                                    onChange={group => setData({ ...data, group })}
                                />
                            ),
                        },
                        { name: 'onlyActive', label: 'only_present', type: 'checkbox', default: false },
                        { name: 'activeFirst', label: 'present_first', type: 'checkbox', default: true },
                        {
                            name: 'showGuests',
                            label: 'show_guests',
                            tooltip: 'show_guests_tooltip',
                            type: 'checkbox',
                            default: true,
                        },
                        { name: 'noCard', label: 'noCard', type: 'checkbox' },
                        { name: 'widgetTitle', label: 'name', hidden: 'data.noCard === true' },
                    ],
                },
            ],
            visDefaultStyle: {
                width: 320,
                height: 360,
                position: 'relative',
            },
            visPrev: 'widgets/teltonika/img/prev_presence.svg',
        };
    }

    public getWidgetInfo(): RxWidgetInfo {
        return TeltonikaPresence.getWidgetInfo();
    }

    componentDidMount(): void {
        super.componentDidMount();
        this.watcher = new StateWatcher(this.props.context.socket, presence => this.setState({ presence }));
        // the durations change every minute
        this.ticker = setInterval(() => this.forceUpdate(), 60_000);
        void this.loadPersons();
    }

    componentWillUnmount(): void {
        this.watcher?.stop();
        this.watcher = null;
        if (this.ticker) {
            clearInterval(this.ticker);
            this.ticker = null;
        }
        super.componentWillUnmount();
    }

    onRxDataChanged(prevRxData: TeltonikaPresenceRxData): void {
        const rxData = this.state.rxData;
        if (
            prevRxData.instance !== rxData.instance ||
            (prevRxData.group || '') !== (rxData.group || '') ||
            prevRxData.showGuests !== rxData.showGuests
        ) {
            this.setState({ persons: null }, () => void this.loadPersons());
        }
    }

    /** `teltonika.<n>` of the attribute `instance` */
    private getInstanceId(): string {
        return instanceIdOf(this.state.rxData.instance);
    }

    private getGuestsId(): string {
        return `${this.getInstanceId()}.presence.guests.count`;
    }

    /** The persons of the instance, only the ones of the group if one is set */
    private async loadPersons(): Promise<void> {
        const group = (this.state.rxData.group || '').trim().toLowerCase();
        const persons = (await loadPersons(presenceSocketOf(this.props.context.socket), this.getInstanceId())).filter(
            person => !group || person.group.toLowerCase() === group,
        );
        if (!this.watcher) {
            return; // unmounted meanwhile
        }
        const ids = persons.flatMap(person => LIST_STATES.map(name => `${person.id}.${name}`));
        if (this.state.rxData.showGuests !== false) {
            ids.push(this.getGuestsId());
        }
        this.watcher.watch(ids);
        this.setState({ persons: persons.map(person => ({ id: person.id, name: person.name })) });
    }

    /** A person: present or away and for how long, and when it came or left */
    private getRows(): PresenceRow[] {
        const values = this.state.presence;
        const lang = language();
        const now = Date.now();
        return (this.state.persons || []).map(person => {
            const active = toBool(values[`${person.id}.${PERSON_STATES.present}`]);
            if (active === undefined) {
                return { ...person, active, info: '…', time: '' };
            }
            const since = toNumber(
                values[`${person.id}.${active ? PERSON_STATES.lastArrival : PERSON_STATES.lastDeparture}`],
            );
            const minutes = toNumber(
                values[`${person.id}.${active ? PERSON_STATES.presentSince : PERSON_STATES.absentSince}`],
            );
            let duration = 0;
            if (since && since <= now) {
                duration = now - since;
            } else if (minutes) {
                duration = minutes * 60_000;
            }
            const word = I18n.t(active ? 'telt_is_present' : 'telt_is_away');
            return {
                ...person,
                active,
                info: duration ? `${word} · ${formatDuration(duration, lang)}` : word,
                time: since ? formatEventTime(since, lang) : '',
            };
        });
    }

    private renderList(): React.JSX.Element {
        const rxData = this.state.rxData;
        const persons = this.state.persons;
        if (!persons) {
            return (
                <Box sx={{ display: 'flex', justifyContent: 'center', p: 2 }}>
                    <CircularProgress size={24} />
                </Box>
            );
        }

        let rows = this.getRows();
        const present = rows.filter(row => row.active).length;
        const guests = rxData.showGuests !== false ? toNumber(this.state.presence[this.getGuestsId()]) : undefined;
        const summary = I18n.t('telt_present_count', String(present), String(persons.length));
        if (rxData.onlyActive) {
            rows = rows.filter(row => row.active);
        }
        if (rxData.activeFirst !== false) {
            rows.sort((a, b) => Number(!!b.active) - Number(!!a.active) || a.name.localeCompare(b.name));
        }

        return (
            <Box
                sx={theme => ({
                    display: 'flex',
                    flexDirection: 'column',
                    minHeight: 0,
                    height: '100%',
                    width: '100%',
                    fontFamily: theme.typography.fontFamily,
                    color: theme.palette.text.primary,
                })}
            >
                <Box sx={theme => ({ flex: '0 0 auto', fontSize: 12, color: muted(theme), mb: '6px' })}>
                    {guests === undefined ? summary : `${summary} · ${I18n.t('telt_guests_count', String(guests))}`}
                </Box>
                {!rows.length ? (
                    <Box sx={theme => ({ fontSize: 13, color: muted(theme), py: 1 })}>
                        {I18n.t(persons.length ? 'telt_nobody_present' : 'telt_no_persons')}
                    </Box>
                ) : null}
                <Box sx={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', mx: '-4px', px: '4px' }}>
                    {rows.map(row => (
                        <Box
                            key={row.id}
                            sx={{ display: 'flex', alignItems: 'center', gap: '10px', py: '6px', minWidth: 0 }}
                        >
                            <Box
                                sx={theme => ({
                                    flex: '0 0 auto',
                                    width: 32,
                                    height: 32,
                                    borderRadius: '50%',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    color: row.active ? theme.palette.success.main : faint(theme),
                                    backgroundColor: row.active
                                        ? alpha(theme.palette.success.main, 0.15)
                                        : alpha(theme.palette.text.primary, 0.06),
                                    '& .MuiSvgIcon-root': { fontSize: 18 },
                                })}
                            >
                                {row.active ? <IconPerson /> : <IconAway />}
                            </Box>
                            <Box sx={{ flex: '1 1 auto', minWidth: 0 }}>
                                <Box sx={{ ...ellipsis, fontSize: 14, fontWeight: 600, lineHeight: 1.3 }}>
                                    {row.name}
                                </Box>
                                <Box
                                    sx={theme => ({ ...ellipsis, fontSize: 12, lineHeight: 1.35, color: muted(theme) })}
                                >
                                    {row.info}
                                </Box>
                            </Box>
                            {row.time ? (
                                <Box
                                    sx={theme => ({
                                        flex: '0 0 auto',
                                        fontSize: 12,
                                        color: muted(theme),
                                        fontVariantNumeric: 'tabular-nums',
                                    })}
                                >
                                    {row.time}
                                </Box>
                            ) : null}
                        </Box>
                    ))}
                </Box>
            </Box>
        );
    }

    public renderWidgetBody(props: RxRenderWidgetProps): React.JSX.Element | React.JSX.Element[] | null {
        super.renderWidgetBody(props);

        const content = this.renderList();
        if (this.state.rxData.noCard || props.widget?.usedInWidget) {
            return (
                <div style={{ width: '100%', height: '100%', overflow: 'hidden', boxSizing: 'border-box' }}>
                    {content}
                </div>
            );
        }
        return this.wrapContent(content, null, {
            alignItems: 'stretch',
            minHeight: 0,
            padding: 12,
            paddingBottom: 12,
            // explicit box-sizing: with a CssBaseline the card content is border-box, without it content-box
            boxSizing: 'border-box',
            height: '100%',
            overflow: 'hidden',
        });
    }
}
