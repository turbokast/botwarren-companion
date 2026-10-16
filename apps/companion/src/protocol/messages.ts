/**
 * Inner message kinds (v1) and their strict schemas. Only these exist: there is no free-text, terminal-output or tool-output kind.
 * Licence: Apache-2.0.
 */
import { z } from 'zod';
import { bs, hex, utf8 } from './bytes.ts';
import { HostCtl, SCOPES, SessionCtl } from './control.ts';

export const MAX_RECENT = 3;
/** what a device that has not said it can read long messages gets (every 0.1.0 to 0.1.2 client): these are the limits of the first versions */
export const MAX_RECENT_CHARS = 600;
export const MAX_PREVIEW_CHARS = 1200;
export const MAX_SUMMARY_CHARS = 300;
/**
 * Long messages (0.1.3), for a device that sent the capability `long1` with its `sync`: each shown text may be this long (in characters) and the whole
 * state still has to fit one frame of at most 64 KB padded (see STATE_BUDGET_BYTES in the host). Text over a limit is cut at the END and the cut is
 * reported in `cut` (never silently); a request whose preview was cut cannot be approved from the phone.
 */
export const MAX_RECENT_CHARS_LONG = 24_000;
export const MAX_PREVIEW_CHARS_LONG = 24_000;
export const MAX_SUMMARY_CHARS_LONG = 2_000;
export const CAP_LONG = 'long1';

export const Rid = z.string().regex(/^[a-z0-9-]{4,40}$/);
export const Sid = z.string().regex(/^[a-z0-9]{6,24}$/);

export const OptionSchema = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/), label: z.string().min(1).max(80) }).strict();
export type Option = z.infer<typeof OptionSchema>;

/**
 * Protocol revision of the inner messages. 1 = companion 0.1.x (Claude Code, Codex and Ninox cards, outcomes up to `failed`). 2 = companion 0.2.0:
 * more agent kinds, `mode`, `source`, `risk`, `denyWith`, `host.away` and the outcome `sent`. A phone says which it understands in `sync`; the host
 * sends the new fields only to a phone that said 2 (decision 6: client first, then host), and leaves out what an older phone cannot parse.
 * 3 = companion 0.3.0: remote control (control.ts, PROTOCOL3.md): scopes, `ctl` on the state, watch/tail/history, prompt, interrupt, start, answer and WebAuthn step-up.
 */
export const PROTO_VERSION = 3;
export const AGENT_KINDS = ['claude-code', 'codex', 'ninox', 'muse', 'opencode', 'agy', 'herdr', 'copilot', 'other'] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];
/** the kinds a proto 1 phone can parse */
export const PROTO1_AGENT_KINDS: readonly AgentKind[] = ['claude-code', 'codex', 'ninox'];
export const SESSION_MODES = ['normal', 'bypass', 'unknown'] as const;
export const RISK_TAGS = ['outside_workspace', 'network', 'protected_write', 'escalated', 'destructive', 'screen_sourced', 'unknown_tool'] as const;
export type RiskTag = (typeof RISK_TAGS)[number];

export const PendingSchema = z.object({
  rid: Rid,
  kind: z.enum(['permission', 'question', 'idle']),
  tool: z.string().max(60).optional(),
  summary: z.string().max(MAX_SUMMARY_CHARS_LONG),
  preview: z.string().max(MAX_PREVIEW_CHARS_LONG),
  /** characters the computer cut from the end of the preview (long1 devices only; absent = nothing cut) */
  cut: z.number().int().min(1).optional(),
  options: z.array(OptionSchema).max(8).optional(),
  expires: z.number().int(),
  bind: z.string().regex(/^[0-9a-f]{64}$/),
  /** proto 2. Where the text came from: a structured field of the tool (hook or API), or read off a terminal screen (never answerable, shown with a label) */
  source: z.enum(['structured', 'screen']).catch('screen').optional(),
  /** proto 2. Display-only warnings next to the buttons. An open vocabulary on purpose: a phone that does not know a tag shows it as plain text. */
  risk: z.array(z.string().regex(/^[a-z_]{1,24}$/)).max(8).optional(),
  /** proto 2. Preset ids a permission request can be denied with ("Deny and say ..."): the host looks the text up in its own list, the phone never supplies it */
  denyWith: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,40}$/)).max(8).optional(),
  /** what the device may do with this request (the companion decides; e.g. a held hook or a channel is needed to answer) */
  /** `deny` (proto 2): this request can be DENIED from here but not approved (the tool ignores an approval that comes from outside, as Muse does) */
  can: z.object({ approve: z.boolean(), reply: z.boolean(), deny: z.boolean().optional() }).strict(),
}).strict();
export type Pending = z.infer<typeof PendingSchema>;

export const RecentSchema = z.object({ role: z.enum(['assistant', 'user']), text: z.string().max(MAX_RECENT_CHARS_LONG), ts: z.number().int(), cut: z.number().int().min(1).optional() }).strict();
export const SessionSchema = z.object({
  sid: Sid,
  agent: z.enum(AGENT_KINDS).catch('other'),
  /** proto 2. `bypass` = the agent runs without approval prompts (nothing to approve); `unknown` = could not tell */
  mode: z.enum(SESSION_MODES).catch('unknown').optional(),
  label: z.string().max(60),
  status: z.enum(['working', 'waiting', 'idle', 'ended']),
  since: z.number().int(),
  pending: PendingSchema.optional(),
  recent: z.array(RecentSchema).max(MAX_RECENT),
  /** proto 3. What this device may do with the session and the `bind` its commands must echo (see control.ts) */
  ctl: SessionCtl.optional(),
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
    /** proto 2. The person said they are away from the computer: hooks that can hold a request (Codex, Muse) wait for a phone answer for a short while */
    away: z.boolean().optional(),
    devices: z.array(z.object({ id8: z.string().length(8), name: z.string().max(40), lastSeen: z.number().nullable(), /** proto 3 */ scope: z.enum(SCOPES).optional() }).strict()).max(8),
    /** proto 3. This device's own control settings: mode, scope, step-up kind, launch table (see control.ts) */
    ctl: HostCtl.optional(),
  }).strict(),
  presets: z.array(PresetSchema).max(8),
  sessions: z.array(SessionSchema).max(20),
}).strict();
export type StateData = z.infer<typeof StateData>;

/** `sent` (proto 2): the answer was delivered but the tool's own follow-up was not seen, so it is not claimed as applied */
export const OUTCOMES = ['applied', 'sent', 'denied', 'expired', 'stale', 'rejected', 'needs_local', 'paused', 'rate_limited', 'failed'] as const;
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
/** `caps`: what this device can read beyond the first version (0.1.3 clients send ["long1"]); an older client sends {} and gets the short form */
export const SyncData = z.object({ proto: z.number().int().min(1).max(99).optional(), caps: z.array(z.string().regex(/^[a-z0-9]{1,12}$/)).max(8).optional() }).strict();
export type SyncData = z.infer<typeof SyncData>;

/**
 * Phone alerts (v1.1). The device registers its own Web Push subscription with the host INSIDE the encrypted channel; the host seals every alert
 * itself (RFC 8291) and asks the relay only to deliver the ciphertext. `on:false` withdraws the subscription. The host answers with `pushack`.
 */
export const PushSub = z.object({
  endpoint: z.string().min(12).max(1024).regex(/^https:\/\//),
  p256dh: z.string().regex(/^[A-Za-z0-9_-]{80,100}$/),
  auth: z.string().regex(/^[A-Za-z0-9_-]{20,30}$/),
}).strict();
export type PushSub = z.infer<typeof PushSub>;
export const PushRegData = z.object({ on: z.boolean(), sub: PushSub.optional() }).strict().refine((d) => !d.on || !!d.sub, { message: 'a subscription is needed to turn alerts on' });
export type PushRegData = z.infer<typeof PushRegData>;
/** why alerts are or are not on for this device, as the host sees it */
export const PushAckData = z.object({ on: z.boolean(), why: z.enum(['ok', 'off', 'host_off', 'rejected']).optional() }).strict();
export type PushAckData = z.infer<typeof PushAckData>;

/** the payload of an alert, sealed for the device's subscription. There is nothing else in it: the service worker shows fixed words. */
export const AlertPayload = z.union([
  z.object({ v: z.literal(1), k: z.literal('waiting'), r: z.string().regex(/^[a-z0-9-]{4,40}$/).optional() }).strict(),
  /** the phone's "Send a test alert": `n` is the phone's own random id for it, echoed so the page knows which test arrived */
  z.object({ v: z.literal(1), k: z.literal('test'), n: z.string().regex(/^[A-Za-z0-9_-]{8,32}$/) }).strict(),
]);
export type AlertPayload = z.infer<typeof AlertPayload>;

/** phone to computer: "send me a test alert now" (computer answers `pushtestack` as it goes, then the alert itself arrives through the push service) */
export const PushTestData = z.object({ n: z.string().regex(/^[A-Za-z0-9_-]{8,32}$/) }).strict();
export type PushTestData = z.infer<typeof PushTestData>;
export const PUSH_TEST_FAILS = ['alerts_off', 'no_subscription', 'rate_limited', 'relay_off', 'relay_busy', 'bad_endpoint', 'push_gone', 'push_refused', 'not_sent'] as const;
/** received: the computer has the request; pushed: the relay handed the sealed alert to the push service; failed: it stopped, `why` says where */
export const PushTestAck = z.object({ n: z.string().regex(/^[A-Za-z0-9_-]{8,32}$/), stage: z.enum(['received', 'pushed', 'failed']), why: z.enum(PUSH_TEST_FAILS).optional() }).strict();
export type PushTestAck = z.infer<typeof PushTestAck>;
export const TEST_REPLACE_KEY = 't';

/** the replace key of every state frame: the newest one wins at the relay */
export const STATE_REPLACE_KEY = 's';

export const HOST_KINDS = ['state', 'result', 'keyupdate', 'revoked', 'pushack', 'pushtestack'] as const;
export const DEVICE_KINDS = ['action', 'sync', 'keyupdate', 'push', 'pushtest'] as const;
/** replace keys of the device's own frames, so a computer that is away does not pile up a phone's reconnects (newest wins) */
export const DEVICE_REPLACE_KEYS = { sync: 'y', push: 'p', keyupdate: 'k' } as const;

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

/**
 * SHA-256 over exactly what the user is shown, so an approval can only apply to that request. The proto 2 display fields (source, risk, denyWith) are
 * hashed only when present, so a request that has none (every 0.1.x request) hashes exactly as before.
 */
export async function bindOf(p: { rid: string; kind: string; tool?: string | undefined; summary: string; preview: string; options?: readonly Option[] | undefined; source?: string | undefined; risk?: readonly string[] | undefined; denyWith?: readonly string[] | undefined }): Promise<string> {
  const parts = [p.rid, p.kind, p.tool ?? '', p.summary, p.preview, JSON.stringify(p.options ?? [])];
  if (p.source || p.risk?.length || p.denyWith?.length) parts.push(p.source ?? '', (p.risk ?? []).join(','), (p.denyWith ?? []).join(','));
  return hex(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bs(utf8(parts.join('\u0000'))))));
}
