/**
 * The adapter interface: one module per coding agent, one host that decides (docs/ADAPTERS.md).
 *
 * An adapter OBSERVES a tool (sessions, what is pending, the last messages) and DELIVERS one already-authorised answer. It never decides: pause, rate
 * limit, device checks, `bind`, local confirmation and expiry all stay in `CompanionHost.onAction`. The answer vocabulary is closed and has no scope:
 * there is no "always", "for this session", "amend the policy", free text or key name in `Answer`. A tool whose only choice is wider than "once" is
 * reported as "answer on your computer" (`can: {approve:false}`).
 *
 * Adapters import nothing from the crypto, relay or store modules and have no network access (see io.ts for the few local things they may touch).
 * Licence: Apache-2.0.
 */
import type { AgentKind, Option, RiskTag, Route, StartMode, TailKind } from '../protocol/index.ts';

export type { AgentKind, RiskTag, Route, StartMode, TailKind };
/** how sure we are that an answer reaches exactly what was shown: A vendor API with an exact request id, B vendor hook/channel identified by invocation, C keystrokes (not built) */
export type Safety = 'A' | 'B' | 'C';
export type ConfirmMode = 'off' | 'risky' | 'always';

declare const presetBrand: unique symbol;
/** text an agent may receive. Only the host can construct it (preset.ts), from its own preset list: an adapter can pass it on, never make it up. */
export type PresetText = string & { readonly [presetBrand]: true };

declare const controlBrand: unique symbol;
/**
 * Text a paired device wrote (a prompt, a first prompt, a free-text answer), after the host cleaned and checked it (length, no leading `!` or `/` on a
 * keystroke route, device scope and step-up). Only the host can construct it (preset.ts): an adapter can deliver one, never make one up.
 */
export type ControlText = string & { readonly [controlBrand]: true };

/** what an adapter delivers for a prompt: the cleaned text, and the same text with the provenance line the agent will read */
export interface ControlPrompt {
  /** the device's text only */
  text: ControlText;
  /** provenance first, then the text: "[Botwarren Companion: sent from paired device 'X']" */
  framed: ControlText;
  /** the device's name, restricted to plain characters */
  from: string;
}

export type Answer =
  /** `allow` always means "this once". `message` (deny only) is a host preset. */
  | { t: 'permission'; behavior: 'allow' | 'deny'; message?: PresetText }
  /** one of the options this adapter itself reported for the pending request; `text` is what the adapter said that option means */
  | { t: 'option'; optionId: string; text: PresetText }
  | { t: 'preset'; text: PresetText; presetId: string };

/** the tool's own handle on a pending request, re-checked right before and right after delivery */
export interface NativeRef {
  adapter: string;
  kind: 'request_id' | 'invocation' | 'screen';
  id: string;
  fingerprint: string;
}

export interface PendingReport {
  sessionKey: string;
  kind: 'permission' | 'question' | 'idle';
  tool?: string;
  summary: string;
  preview: string;
  options?: Option[];
  ttlMs: number;
  /** null = nothing to deliver to (read-only): the phone shows "answer on your computer" */
  native: NativeRef | null;
  /** `deny`: only a denial can be delivered (the tool ignores an approval that comes from outside); `approve` stays false */
  can: { approve: boolean; reply: boolean; deny?: boolean };
  /** deny-with-preset on a permission request is possible (the host offers its non-affirming presets) */
  denyWithPreset?: boolean;
  /** report this only if nothing is pending for the session (a hint from a tool's notification must not replace a request that is being held) */
  onlyIfNone?: boolean;
  risk: readonly RiskTag[];
  source: 'structured' | 'screen';
  optionText?: Record<string, PresetText>;
}

export interface SessionReport {
  key: string;
  agent: AgentKind;
  cwd?: string;
  label?: string;
  status: 'working' | 'waiting' | 'idle' | 'ended';
  mode?: 'normal' | 'bypass' | 'unknown';
  /** ids another adapter may know this session by (Herdr's `agent_session.value`, Ninox's `claude_session_id`): sessions that share one are merged */
  correlate?: string[];
  /** an observer (Herdr, Ninox): if the session is already known from a richer source it is only given the extra ids, its state and mode are not touched */
  passive?: boolean;
}

/**
 * What an adapter can DO to a session beyond answering a request (protocol 3, see PROTOCOL3.md section 7). Declared honestly: a capability
 * that is not verified for the tool is `false`, and the host and the conformance suite (test/conformance/control.conformance.ts) both rely on it.
 */
export interface ControlCaps {
  /** deliver free text to a running session */
  prompt: boolean;
  /** stop what the agent is doing */
  interrupt: boolean;
  /** `softInterrupt`: it stops at the next tool boundary, not mid-generation (the UI says so) */
  softInterrupt: boolean;
  /** deliver free text as the answer to a pending question */
  answer: boolean;
  /** start a new session from a host launch entry */
  start: boolean;
  /** feeds `ctx.report.tail` */
  tail: boolean;
  /** how a prompt reaches the tool. `keys` = typed into a terminal (the host then refuses text starting with `!` or `/`). `none` when nothing is deliverable. */
  route: Route;
}
export const NO_CONTROL: ControlCaps = { prompt: false, interrupt: false, softInterrupt: false, answer: false, start: false, tail: false, route: 'none' };

export interface AdapterManifest {
  id: string;
  kind: AgentKind;
  safety: Safety;
  caps: { detect: boolean; readPending: boolean; readRecent: boolean; approve: boolean; deny: boolean; presetReply: boolean; optionAnswer: boolean };
  /** plain-language list of what this adapter reads (`botwarren-companion adapters explain <id>`) */
  reads: readonly string[];
  /** answering is enabled only on these tool versions (a trailing `.*` matches a family); any other version is read-only */
  verified: { versions: readonly string[] };
  /** local confirmation floors: the user's configuration can only be stricter */
  confirmFloor: { approve: ConfirmMode; reply: ConfirmMode };
  /**
   * true: after an allow is delivered the host waits (briefly) for the tool's own follow-up (`report.resolved`) and says `applied` only if it came,
   * else `sent`. false: the tool answers synchronously, so delivery is the outcome (Claude Code's channel).
   */
  observesOutcome: boolean;
  /** protocol 3: what this adapter can do to a session besides answering a pending request; `NO_CONTROL` for an observer */
  control: ControlCaps;
}

export interface DetectResult { present: boolean; version?: string; note?: string }
export interface DoctorLine { label: string; value: string; ok: boolean | null }

/** What the host tells an adapter about itself; read-only. */
export interface HostFacts { away: boolean; paused: boolean; relayOnline: boolean; devices: number }

export interface AdapterConfig {
  enabled: boolean;
  /** hook-family tools: `never` = report only; `away` = hold up to `holdSeconds` while the person is away (never more than 45) */
  hold: 'never' | 'away';
  holdSeconds: number;
  /** tool versions the person tested themselves (`adapters verify`), in addition to the ones this release lists */
  verifiedVersions?: string[];
  [k: string]: unknown;
}

export interface AdapterContext {
  now(): number;
  facts(): HostFacts;
  /** this adapter's slice of config.json, re-read on every call */
  config(): AdapterConfig;
  /** the audit log line: kinds, counts and booleans only, never content */
  audit(kind: string, fields?: Record<string, string | number | boolean>): void;
  report: {
    /** a `passive` report on a session another source already knows returns `existing` and changes nothing but its ids */
    session(s: SessionReport): 'created' | 'existing';
    pending(p: PendingReport): Promise<void>;
    /** `onlyNative`: clear only if the pending request is still the one with this native id (a newer request is left alone). `onlySource`: clear only a request that came from that source. Returns whether something was cleared. */
    cleared(sessionKey: string, why: 'answered_local' | 'tool_ran' | 'expired' | 'ended' | 'replaced' | 'prompt' | 'stop', onlyNative?: string, onlySource?: 'screen' | 'structured'): boolean;
    /** the host masks and truncates */
    recent(sessionKey: string, texts: { text: string; ts: number }[]): void;
    /** the tool's follow-up that proves an answer took effect */
    resolved(n: NativeRef, how: 'allowed' | 'denied' | 'unknown'): void;
    /** something changed: push a state to the phones soon */
    changed(urgent?: boolean): void;
    /**
     * New lines for the session's live tail (assistant text, one-line tool-call summaries, the tool's own record of a prompt). The host cleans, masks and
     * bounds them; `tool_out` is dropped unless the owner turned tool output on for the session. Call only if `manifest.control.tail`.
     */
    tail(sessionKey: string, items: { k: TailKind; text: string; ts: number }[]): void;
    /** the tool's own proof that a control command took effect (a new turn began, it stopped, the answer was taken): turns `sent` into `applied` */
    followup(sessionKey: string, what: 'prompt' | 'interrupt' | 'answer'): void;
  };
}

export type DeliverResult = 'delivered' | 'gone' | 'changed' | 'unsupported' | 'failed';
export type Revalidation = 'live' | 'gone' | 'changed';

export interface Adapter {
  readonly manifest: AdapterManifest;
  detect(): Promise<DetectResult>;
  start(ctx: AdapterContext): Promise<void>;
  stop(): Promise<void>;
  /** immediately before delivery, and again right after: is this native object still the pending one? */
  revalidate(n: NativeRef): Promise<Revalidation>;
  deliver(n: NativeRef, a: Answer, who: { device: string }): Promise<DeliverResult>;
  /** the pending request was withdrawn (answered at the terminal, expired, replaced): let go of whatever was held for it */
  release(n: NativeRef): void;
  doctor(): Promise<DoctorLine[]>;
}

export type ControlDelivery = 'delivered' | 'gone' | 'busy' | 'unsupported' | 'failed';

/** the host's own launch table entry, as handed to an adapter: the client never supplies any of it */
export interface LaunchSpec { id: string; label: string; harness: AgentKind; root: string; mode: StartMode }

/**
 * An adapter that can also act on a session (protocol 3). The host has already decided (scope, control mode, step-up, bind, rate, bypass, text rules);
 * the adapter only delivers, and answers honestly: `unsupported` for what its manifest does not declare, `gone` for a session it no longer has, `busy`
 * when the tool cannot take it now. It must not retry, queue on its own or widen the text (the types make an invented text impossible).
 */
export interface ControlAdapter extends Adapter {
  /**
   * Optional: what THIS session can take right now, narrower than the manifest (a Claude Code session whose channel is not connected cannot take a prompt, one
   * whose control hook has not been seen cannot be stopped). The host only ever narrows with it (`false` removes a capability, nothing is added), so what a
   * phone is shown is true for the session in front of it. Absent: the manifest applies to every session.
   */
  sessionCaps?(sessionKey: string): Partial<Pick<ControlCaps, 'prompt' | 'interrupt' | 'answer' | 'tail'>> | null;
  sendPrompt(sessionKey: string, p: ControlPrompt, who: { device: string }): Promise<ControlDelivery>;
  interrupt(sessionKey: string, who: { device: string }): Promise<ControlDelivery>;
  /** free text for the pending question `n` names (re-validated by the host just before) */
  answerText(n: NativeRef, text: ControlText, who: { device: string }): Promise<ControlDelivery>;
  /** a new session in `launch.root` with `launch.mode`; `text` is the optional first prompt. `sessionKey` is the key the tool will report it under, when already known. */
  startSession(launch: LaunchSpec, text: ControlPrompt | null, who: { device: string }): Promise<{ result: ControlDelivery; sessionKey?: string }>;
}

export const isControlAdapter = (a: Adapter): a is ControlAdapter => typeof (a as Partial<ControlAdapter>).sendPrompt === 'function' && typeof (a as Partial<ControlAdapter>).interrupt === 'function';

export interface HookCall {
  event: string;
  input: Record<string, unknown>;
  /** process ids from the hook process up to init (matches a channel server of the same Claude process) */
  ancestors: number[];
  /** true once the hook process has gone away (answered locally, killed, timed out) */
  cancelled: () => boolean;
  onCancel: (fn: () => void) => void;
}

/** an adapter that is fed by the tool's hook process (the `hook` command): the daemon passes each hook call to it */
export interface HookAdapter extends Adapter {
  onHook(h: HookCall): Promise<Record<string, unknown> | null>;
}

/** `0.162.1` matches `0.162.1` and `0.162.*`; an unknown version (null) matches nothing */
export function versionVerified(version: string | null | undefined, patterns: readonly string[]): boolean {
  if (!version) return false;
  return patterns.some((p) => (p.endsWith('.*') ? version.startsWith(p.slice(0, -1)) : version === p));
}

const ORDER: Record<ConfirmMode, number> = { off: 0, risky: 1, always: 2 };
/** the stricter of two confirmation modes */
export const stricter = (a: ConfirmMode, b: ConfirmMode): ConfirmMode => (ORDER[a] >= ORDER[b] ? a : b);

/** only plain characters of a device's name go into text an agent reads (the name is chosen at pairing and could be anything) */
export const safeDeviceName = (s: string): string => s.replace(/[^A-Za-z0-9 _.-]/g, '').slice(0, 40).trim() || 'phone';
