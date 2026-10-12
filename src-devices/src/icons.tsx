// Icons of the person tile, taken from the MUI icons of the host (`@iobroker/dm-widgets` bridge).

import type { ComponentType, JSX } from 'react';
import { MuiIcons, MuiMaterial } from '@iobroker/dm-widgets';
import type { BoxProps, SvgIconProps } from '@mui/material';

const Box: ComponentType<BoxProps> = MuiMaterial?.Box;

export type GlyphProps = Pick<SvgIconProps, 'sx' | 'className'>;

/**
 * An icon of the host's `@mui/icons-material`, with a text glyph as fallback: the host bridges only part of the
 * icon set, and rendering `undefined` as a component would tear down the whole category of the dashboard.
 */
function bridgedIcon(name: string, glyph: string): ComponentType<GlyphProps> {
    const Component = (MuiIcons as Record<string, ComponentType<GlyphProps>> | undefined)?.[name];
    if (Component) {
        return Component;
    }
    return function GlyphIcon({ sx }: GlyphProps): JSX.Element {
        return (
            <Box
                component="span"
                sx={{ lineHeight: 1, display: 'inline-flex', ...(sx as object) }}
            >
                {glyph}
            </Box>
        );
    };
}

export const CloseIcon = bridgedIcon('Close', '✕');
export const ChevronIcon = bridgedIcon('ChevronRight', '›');
export const PersonIcon = bridgedIcon('Person', '☺');
export const ArrivalIcon = bridgedIcon('Login', '→');
export const DepartureIcon = bridgedIcon('Logout', '←');
export const HistoryIcon = bridgedIcon('History', '↺');
export const RefreshIcon = bridgedIcon('Refresh', '↻');
export const DevicesIcon = bridgedIcon('Smartphone', '▯');
export const RouterIcon = bridgedIcon('RouterOutlined', '⌂');
export const WifiIcon = bridgedIcon('Wifi', '≋');
