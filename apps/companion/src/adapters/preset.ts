/**
 * The only place text for an agent is made. The host calls `asPreset` on its own configured preset texts (and on option texts an adapter reported
 * for options the tool itself offered). Adapters must not import this file (a test checks it): they can pass a `PresetText` on, never create one.
 * Licence: Apache-2.0.
 */
import type { ControlText, PresetText } from './types.ts';

export const asPreset = (s: string): PresetText => s as PresetText;
/** text a paired device wrote, only after the host's checks (control.ts); never from an adapter */
export const asControlText = (s: string): ControlText => s as ControlText;
