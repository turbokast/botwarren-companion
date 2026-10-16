/**
 * Protocol 3 (companion 0.3.0): remote control from a paired browser or phone. Message kinds, strict schemas and the small pure helpers both ends share.
 * Spec: PROTOCOL3.md in the Companion's docs folder. Everything here is additive: a device that said `proto` 2 or less in its
 * `sync` is never sent a protocol 3 kind or field (the host checks `proto` before it sends), and the relay is unchanged (it sees only sealed frames).
 * No Node-only APIs: the browser client imports this file. Licence: Apache-2.0.
 */
import { z } from 'zod';
import { bs, hex, utf8, unhex } from './bytes.ts';
/** same shape as Sid in messages.ts (not imported: messages.ts imports this file for the state fields) */
const Sid = z.string().regex(/^[a-z0-9]{6,24}$/);

// ---------------------------------------------------------------- scopes
/** what a paired device may do. `observe` reads (state, tail, history); `answer` adds approve, deny, preset and option replies and interrupt; `control` adds free text and start. The host enforces it. */
export const SCOPES = ['observe', 'answer', 'control'] as const;
export type Scope = (typeof SCOPES)[number];
export const SCOPE_RANK: Readonly<Record<Scope, number>> = { observe: 0, answer: 1, control: 2 };
export const DEFAULT_SCOPE: Scope = 'answer';
export const scopeAtLeast = (have: Scope | undefined, need: Scope): boolean => SCOPE_RANK[have ?? DEFAULT_SCOPE] >= SCOPE_RANK[need];

/** the master switch on the computer (`botwarren-companion control on|readonly|off`). `off` is the state after an upgrade. */
export const CONTROL_MODES = ['off', 'readonly', 'on'] as const;
export type ControlMode = (typeof CONTROL_MODES)[number];

// ---------------------------------------------------------------- limits (the host enforces; the client may use them to disable buttons)
export const MAX_PROMPT_CHARS = 4000;
/** a command is valid this long after the device made it (`x = now + 60 s`); the relay never queues one beyond that */
export const COMMAND_TTL_MS = 60_000;
/** how far in the future an `x` may be (clock skew allowance): beyond COMMAND_TTL_MS + this the command is refused */
export const COMMAND_SKEW_MS = 30_000;
export const CID_DEDUPE_MS = 24 * 3_600_000;
export const UNLOCK_MS_DEFAULT = 15 * 60_000;
export const STEPUP_CHALLENGE_TTL_MS = 60_000;
/** a verified assertion for one command is good for this long, once */
export const STEPUP_GRANT_TTL_MS = 2 * 60_000;
export const WATCH_LEASE_MS = 5 * 60_000;
export const MAX_WATCHED_SESSIONS = 3;
export const TAIL_MIN_GAP_MS = 1_000;
export const HISTORY_MAX_LIMIT = 50;
export const START_MODES = ['default', 'acceptEdits', 'plan'] as const;
export type StartMode = (typeof START_MODES)[number];

// ---------------------------------------------------------------- shared shapes
/** command id: random, chosen by the device, de-duplicated by the host for 24 h; bound into any step-up grant */
export const Cid = z.string().regex(/^[A-Za-z0-9_-]{16,32}$/);
const Bind64 = z.string().regex(/^[0-9a-f]{64}$/);
const B64u = (min: number, max: number) => z.string().regex(/^[A-Za-z0-9_-]+$/).min(min).max(max);
/** text a device sends: up to this many UTF-16 units on the wire (so the host can answer `size` instead of failing the schema); the host counts characters and allows MAX_PROMPT_CHARS */
const WireText = z.string().max(16_000);
const X = z.number().int();

// ---------------------------------------------------------------- device to host: commands
export const PromptData = z.object({ cid: Cid, sid: Sid, bind: Bind64, text: WireText, x: X }).strict();
export type PromptData = z.infer<typeof PromptData>;
/** `bind` is carried so a client can send what it showed; a stale `bind` does NOT stop an interrupt (stopping is always safe) */
export const InterruptData = z.object({ cid: Cid, sid: Sid, bind: Bind64, x: X }).strict();
export type InterruptData = z.infer<typeof InterruptData>;
/** `launchId` indexes the host's own launch table: the client never sends a path, command, flag or environment */
export const StartData = z.object({ cid: Cid, launchId: z.string().regex(/^[a-z0-9-]{1,24}$/), mode: z.enum(START_MODES), text: WireText.optional(), x: X }).strict();
export type StartData = z.infer<typeof StartData>;
/** a free-text answer to a pending question (option answers stay `action` with `a:"reply"`); `rid` and `bind` are those of the pending request that was shown */
export const AnswerData = z.object({ cid: Cid, sid: Sid, rid: z.string().regex(/^[a-z0-9-]{4,40}$/), bind: Bind64, text: WireText, x: X }).strict();
export type AnswerData = z.infer<typeof AnswerData>;
export const WatchData = z.object({ sid: Sid, on: z.boolean() }).strict();
export type WatchData = z.infer<typeof WatchData>;
export const HistoryData = z.object({ sid: Sid, q: z.string().regex(/^[A-Za-z0-9_-]{4,16}$/), before: z.number().int().min(1).optional(), limit: z.number().int().min(1).max(HISTORY_MAX_LIMIT).optional() }).strict();
export type HistoryData = z.infer<typeof HistoryData>;

export const COMMAND_KINDS = ['prompt', 'interrupt', 'start', 'answer'] as const;
export type CommandKind = (typeof COMMAND_KINDS)[number];
export const STEPUP_KINDS = ['prompt', 'start', 'answer'] as const;

// ---------------------------------------------------------------- device to host: step-up (WebAuthn)
/**
 * Ask the host for a challenge. `for:"unlock"` opens the unlock window (15 minutes by default) for `prompt` and free-text `answer`;
 * `for:"cmd"` is for ONE command and carries `cid`, its `kind` and its `digest` (see `commandDigest`); `start` always needs one of these.
 */
export const SuBeginData = z.object({ for: z.enum(['unlock', 'cmd']), cid: Cid.optional(), kind: z.enum(STEPUP_KINDS).optional(), digest: Bind64.optional() }).strict()
  .refine((d) => d.for === 'unlock' || (!!d.cid && !!d.kind && !!d.digest), { message: 'a command step-up needs cid, kind and digest' });
export type SuBeginData = z.infer<typeof SuBeginData>;
/** the WebAuthn assertion exactly as the browser returns it, each binary field base64url: credential id, authenticatorData, clientDataJSON, signature */
export const SuAssertData = z.object({ ch: B64u(16, 64), id: B64u(8, 1024), ad: B64u(37, 2048), cd: B64u(20, 4096), sig: B64u(8, 1024) }).strict();
export type SuAssertData = z.infer<typeof SuAssertData>;
/** registration of a platform credential: asks for a challenge. The computer asks its owner to confirm (locally) before it answers. */
export const SuRegBeginData = z.object({}).strict();
export const SuRegData = z.object({ ch: B64u(16, 64), id: B64u(8, 1024), ao: B64u(32, 8192), cd: B64u(20, 4096) }).strict();
export type SuRegData = z.infer<typeof SuRegData>;

export const DEVICE_KINDS_3 = ['watch', 'history', 'prompt', 'interrupt', 'start', 'answer', 'su_begin', 'su_assert', 'su_regbegin', 'su_reg'] as const;

// ---------------------------------------------------------------- host to device
/** every refusal the host can give, as a code the UI maps to words. `ok` outcomes carry no `why`. */
export const REFUSALS = [
  'proto', 'schema', 'control_off', 'paused', 'scope', 'expired', 'stale', 'size', 'empty', 'keystroke_prefix', 'bypass', 'rate', 'unknown_session', 'ended',
  'unsupported', 'harness', 'project', 'launch_unknown', 'mode_not_allowed', 'stepup_required', 'stepup_invalid', 'local_declined', 'busy', 'no_question',
] as const;
export type Refusal = (typeof REFUSALS)[number];
/**
 * `sent`: delivered, the tool's own follow-up not (yet) seen. `applied`: the follow-up was seen. `refused`: the host did not deliver (`why`).
 * `needs_stepup`: do the step-up, then send the SAME command again (same `cid`). `needs_local`: waiting for a yes at the computer. `failed`: delivery was tried and failed.
 */
export const CONTROL_OUTCOMES = ['applied', 'sent', 'refused', 'needs_stepup', 'needs_local', 'failed'] as const;
export const CResultData = z.object({
  cid: Cid, kind: z.enum(['prompt', 'interrupt', 'start', 'answer']), outcome: z.enum(CONTROL_OUTCOMES),
  why: z.enum(REFUSALS).optional(), note: z.string().max(120).optional(),
  /** `start`: the session the command made, if the tool already reported it */
  sid: Sid.optional(),
  /** true when this is the stored answer to a `cid` the host had already seen: nothing was done again */
  dup: z.boolean().optional(),
}).strict();
export type CResultData = z.infer<typeof CResultData>;

export const TAIL_KINDS = ['assistant', 'user', 'tool', 'tool_out', 'note'] as const;
export type TailKind = (typeof TAIL_KINDS)[number];
/**
 * One line of the live tail. PLAIN TEXT ONLY: the computer has removed terminal escapes, control and bidi characters and masked secret shapes and home paths,
 * but it does not make the text safe to interpret. Render with `textContent`; never as markup, never auto-link, never act on it.
 * `assistant`: the agent's words. `user`: a prompt as the tool recorded it. `tool`: a one-line summary of a tool call. `tool_out`: tool output (only when the owner
 * turned it on at the computer for that session). `note`: written by the companion itself ("prompt sent from <device>").
 */
export const TailEntry = z.object({ seq: z.number().int().min(1), ts: z.number().int(), k: z.enum(TAIL_KINDS), text: z.string().max(4000), cut: z.number().int().min(1).optional() }).strict();
export type TailEntry = z.infer<typeof TailEntry>;
/** the newest window of a watched session (state-like: a newer frame replaces an older one at the relay; earlier lines come from `history`) */
export const TailData = z.object({ sid: Sid, first: z.number().int().min(0), last: z.number().int().min(0), total: z.number().int().min(0), entries: z.array(TailEntry).max(200), tools: z.boolean() }).strict();
export type TailData = z.infer<typeof TailData>;
export const HistData = z.object({ sid: Sid, q: z.string().regex(/^[A-Za-z0-9_-]{4,16}$/), entries: z.array(TailEntry).max(HISTORY_MAX_LIMIT), more: z.boolean(), tools: z.boolean() }).strict();
export type HistData = z.infer<typeof HistData>;

export const SuChallengeData = z.object({
  /** the 32 bytes to pass as the WebAuthn `challenge` (base64url) */
  ch: B64u(43, 43), for: z.enum(['unlock', 'cmd']), cid: Cid.optional(), exp: z.number().int(),
  rp: z.string().max(253), origin: z.string().max(300), cred: B64u(8, 1024),
}).strict();
export type SuChallengeData = z.infer<typeof SuChallengeData>;
export const SU_FAILS = ['scope', 'no_credential', 'no_challenge', 'expired', 'challenge', 'origin', 'type', 'rp', 'user_presence', 'user_verification', 'signature', 'sign_count', 'credential', 'rate', 'malformed', 'control_off'] as const;
export const SuResultData = z.object({ for: z.enum(['unlock', 'cmd']), cid: Cid.optional(), ok: z.boolean(), why: z.enum(SU_FAILS).optional(), until: z.number().int().optional() }).strict();
export type SuResultData = z.infer<typeof SuResultData>;
export const SuRegChallengeData = z.object({ ch: B64u(43, 43), exp: z.number().int(), rp: z.string().max(253), origin: z.string().max(300), user: B64u(8, 64), algs: z.array(z.number().int()).max(4) }).strict();
export type SuRegChallengeData = z.infer<typeof SuRegChallengeData>;
export const SU_REG_FAILS = ['declined', 'no_challenge', 'expired', 'challenge', 'origin', 'type', 'rp', 'user_presence', 'user_verification', 'attestation', 'algorithm', 'key', 'credential', 'rate', 'malformed', 'control_off'] as const;
export const SuRegResultData = z.object({ ok: z.boolean(), why: z.enum(SU_REG_FAILS).optional() }).strict();
export type SuRegResultData = z.infer<typeof SuRegResultData>;

export const HOST_KINDS_3 = ['cresult', 'tail', 'hist', 'su_challenge', 'su_result', 'su_regchallenge', 'su_regresult'] as const;

// ---------------------------------------------------------------- state additions (proto 3 devices only)
export const LaunchView = z.object({ id: z.string().regex(/^[a-z0-9-]{1,24}$/), label: z.string().min(1).max(60), harness: z.string().regex(/^[a-z0-9-]{2,20}$/), modes: z.array(z.enum(START_MODES)).min(1).max(3) }).strict();
export type LaunchView = z.infer<typeof LaunchView>;
/** how a prompt reaches a tool: `api` a vendor API, `channel` the Claude channel, `hook` a hook reply, `keys` typed into a terminal (verify), `none` not at all */
export const ROUTES = ['api', 'channel', 'hook', 'keys', 'none'] as const;
export type Route = (typeof ROUTES)[number];
/** why a control is disabled right now, for the UI to say in words */
export const CTL_WHY = ['control_off', 'scope', 'bypass', 'unsupported', 'harness', 'project', 'ended', 'paused'] as const;
export type CtlWhy = (typeof CTL_WHY)[number];
export const SessionCtl = z.object({
  /** what a `prompt`, `interrupt` or `answer` for this session must echo; changes when the agent moves (new turn, new status, new request) */
  bind: Bind64,
  route: z.enum(ROUTES),
  can: z.object({ prompt: z.boolean(), interrupt: z.boolean(), tail: z.boolean(), text: z.boolean() }).strict(),
  /** set when `can.prompt` is false */
  why: z.enum(CTL_WHY).optional(),
  /** tool output in the tail is shown (the owner turned it on at the computer) or hidden (the default) */
  tools: z.boolean(),
}).strict();
export type SessionCtl = z.infer<typeof SessionCtl>;
export const HostCtl = z.object({
  mode: z.enum(CONTROL_MODES), scope: z.enum(SCOPES),
  /** `webauthn`: this device has a registered credential; `local`: it does not, so free text and start are confirmed at the computer */
  stepup: z.enum(['webauthn', 'local']),
  /** the owner asked for local confirmation of every command from this device */
  confirm: z.boolean(),
  unlockMinutes: z.number().int().min(1).max(60),
  /** only for scope `control` */
  launch: z.array(LaunchView).max(12),
}).strict();
export type HostCtl = z.infer<typeof HostCtl>;

// ---------------------------------------------------------------- pure helpers shared by host and client
export const watchReplaceKey = (sid: string): string => `w${sid.slice(0, 8)}`;

const sha256 = async (b: Uint8Array): Promise<Uint8Array> => new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bs(b)));

/**
 * What a step-up assertion for one command is bound to: SHA-256 over kind, target (the session id, or the launch id plus mode for `start`) and the exact text,
 * length-prefixed so no two different commands share a digest. The device sends it in `su_begin`; the host recomputes it when the command arrives and
 * refuses the command if it differs from what was asserted.
 */
export async function commandDigest(kind: CommandKind, target: string, text: string): Promise<string> {
  const parts = [kind, target, text].map((p) => `${utf8(p).length}:${p}`);
  return hex(await sha256(utf8(`botwarren-cmd-v1\0${parts.join('\0')}`)));
}

/** the host's WebAuthn challenge: SHA-256 over a domain tag, the purpose, the random nonce and the command digest (empty for unlock and registration) */
export async function stepupChallenge(purpose: 'unlock' | 'cmd' | 'reg', nonce: Uint8Array, digestHex = ''): Promise<Uint8Array> {
  const d = digestHex ? unhex(digestHex) : new Uint8Array(0);
  return sha256(new Uint8Array([...utf8(`botwarren-stepup-v1\0${purpose}\0`), ...nonce, 0, ...d]));
}

/** characters, not UTF-16 units */
export const charLength = (s: string): number => { let n = 0; for (const _ of s) n++; return n; };

/** a fresh command id (22 characters) */
export function newCid(): string {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** the `x` of a command made now */
export const commandExpiry = (now: number = Date.now()): number => now + COMMAND_TTL_MS;
