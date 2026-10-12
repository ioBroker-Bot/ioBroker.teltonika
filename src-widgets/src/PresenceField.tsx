// The person (or group) setting of the presence widgets in the vis-2 editor: the names of the persons of the chosen
// instance as a dropdown.
//
// A widget stores the name, not an object ID - the channel of a person carries it in `native.person`. While the
// list cannot be read (no connection, no persons configured yet) any text can be entered.

import type React from 'react';
import { useEffect, useState } from 'react';
import { Autocomplete, TextField } from '@mui/material';
import { I18n } from '@iobroker/gui-components';

import { loadPersons, personGroups, type PresenceSocket } from './presenceApi';
import { instanceIdOf } from './presence';

export default function PresenceField({
    kind,
    socket,
    instance,
    value,
    onChange,
}: {
    /** `person`: the names of the persons, `group`: their groups */
    kind: 'person' | 'group';
    socket: PresenceSocket | undefined;
    /** value of the attribute `instance` */
    instance: unknown;
    value: string;
    onChange: (value: string) => void;
}): React.JSX.Element {
    const instanceId = instanceIdOf(instance);
    const [options, setOptions] = useState<string[]>([]);

    useEffect(() => {
        let cancelled = false;
        if (!socket) {
            setOptions([]);
            return undefined;
        }
        void loadPersons(socket, instanceId).then(persons => {
            if (!cancelled) {
                setOptions(kind === 'group' ? personGroups(persons) : persons.map(person => person.name));
            }
        });
        return () => {
            cancelled = true;
        };
    }, [socket, instanceId, kind]);

    return (
        <Autocomplete
            freeSolo
            fullWidth
            size="small"
            options={options}
            value={value}
            inputValue={value}
            onInputChange={(_event, text, reason) => {
                // `reset` is the value written back by the component itself
                if (reason !== 'reset' || text !== value) {
                    onChange(text);
                }
            }}
            onChange={(_event, selected) => onChange(typeof selected === 'string' ? selected : '')}
            renderInput={params => (
                <TextField
                    {...params}
                    variant="standard"
                    placeholder={kind === 'group' ? I18n.t('telt_all_groups') : ''}
                />
            )}
        />
    );
}
