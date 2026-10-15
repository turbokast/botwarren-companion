/**
 * Inner message kinds (v1) and their strict schemas. Only these exist: there is no free-text, terminal-output or tool-output kind.
 * Licence: Apache-2.0.
 */
import { z } from 'zod';
import { bs, hex, utf8 } from './bytes.ts';

export const MAX_RECENT = 3;
export const MAX_RECENT_CHARS = 600;
export const MAX_PREVIEW_CHARS = 1200;
export const MAX_SUMMARY_CHARS = 300;

export const Rid = z.string().regex(/^[a-z0-9-]{4,40}$/);
export const Sid = z.string().regex(/^[a-z0-9]{6,24}$/);

export const OptionSchema = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/), label: z.string().min(1).max(80) }).strict();
export type Option = z.infer<typeof OptionSchema>;

export const PendingSchema = z.object({
  rid: Rid,
  kind: z.enum(['permission', 'question', 'idle']),
  tool: z.string().max(60).optional(),
  summary: z.string().max(MAX_SUMMARY_CHARS),
  preview: z.string().max(MAX_PREVIEW_CHARS),
  options: z.array(OptionSchema).max(8).optional(),
  expires: z.number().int(),
  bind: z.string().regex(/^[0-9a-f]{64}$/),
  /** what the device may do with this request (the companion decides; e.g. a held hook or a channel is needed to answer) */
  can: z.object({ approve: z.boolean(), reply: z.boolean() }).strict(),
}).strict();
export type Pending = z.infer<typeof PendingSchema>;

export const RecentSchema = z.object({ role: z.enum(['assistant', 'user']), text: z.string().max(MAX_RECENT_CHARS), ts: z.number().int() }).strict();
export const SessionSchema = z.object({
  sid: Sid,
  agent: z.enum(['claude-code', 'codex', 'ninox']),
  label: z.string().max(60),
  status: z.enum(['working', 'waiting', 'idle', 'ended']),
  since: z.number().int(),
  pending: PendingSchema.optional(),
  recent: z.array(RecentSchema).max(MAX_RECENT),
}).strict();
export type SessionState = z.infer<typeof SessionSchema>;

export const PresetSchema = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/), label: z.string().min(1).max(60) }).strict();
export type Preset = z.infer<typeof PresetSchema>;

export const StateData = z.object({
  rev: z.number().int().min(0),
  host: z.object({
    name: z.string().max(40), paused: z.boolean(),
    confirm: z.object({ approve: z.enum(['off', 'always', 'risky']), reply: z.enum(['off', 'always', 'risky']) }).strict(),
    /** the paired devices (names and last seen), so a phone can show them; removing one is done on the computer */
    devices: z.array(z.object({ id8: z.string().length(8), name: z.string().max(40), lastSeen: z.number().nullable() }).strict()).max(8),
  }).strict(),
  presets: z.array(PresetSchema).max(8),
  sessions: z.array(SessionSchema).max(20),
}).strict();
export type StateData = z.infer<typeof StateData>;

export const OUTCOMES = ['applied', 'denied', 'expired', 'stale', 'rejected', 'needs_local', 'paused', 'rate_limited', 'failed'] as const;
export const ResultData = z.object({ rid: Rid, outcome: z.enum(OUTCOMES), note: z.string().max(120).optional() }).strict();
export type ResultData = z.infer<typeof ResultData>;

export const ActionData = z.object({
  rid: Rid, sid: Sid, a: z.enum(['approve', 'deny', 'reply']),
  opt: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/).optional(),
  bind: z.string().regex(/^[0-9a-f]{64}$/),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{8,32}$/),
}).strict();
export type ActionData = z.infer<typeof ActionData>;

export const KeyUpdateData = z.object({ ep: z.number().int().min(0), kem: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
export type KeyUpdateData = z.infer<typeof KeyUpdateData>;

export const RevokedData = z.object({ reason: z.enum(['removed', 'account_off']) }).strict();
export const SyncData = z.object({}).strict();

export const HOST_KINDS = ['state', 'result', 'keyupdate', 'revoked'] as const;
export const DEVICE_KINDS = ['action', 'sync', 'keyupdate'] as const;

export const DEFAULT_PRESETS: readonly Preset[] = [
  { id: 'continue', label: 'Continue' },
  { id: 'yes', label: 'Yes, go ahead' },
  { id: 'no', label: 'No, do not do that' },
  { id: 'stop', label: 'Stop and wait for me' },
  { id: 'summary', label: 'Summarise where you are' },
];

/** the text the agent receives for a preset reply: host-defined, with a provenance prefix added by the companion */
export const DEFAULT_PRESET_TEXT: Readonly<Record<string, string>> = {
  continue: 'Please continue.',
  yes: 'Yes, go ahead.',
  no: 'No, do not do that.',
  stop: 'Please stop and wait for me to return.',
  summary: 'Please summarise where you are and what you need from me.',
};

/** SHA-256 over exactly what the user is shown, so an approval can only apply to that request */
export async function bindOf(p: { rid: string; kind: string; tool?: string | undefined; summary: string; preview: string; options?: readonly Option[] | undefined }): Promise<string> {
  const s = [p.rid, p.kind, p.tool ?? '', p.summary, p.preview, JSON.stringify(p.options ?? [])].join('\u0000');
  return hex(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bs(utf8(s)))));
}
