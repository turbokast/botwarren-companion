/**
 * What the remote-control screens need, in the words of the screens (design: "Remote control" board R1 to R15 and D1 to D3 in the Botwarren Claude
 * Design project). The screens never touch the wire protocol: they talk to a `ControlApi`. `adapter.ts` builds one from the real link; the Playwright
 * harness builds one from a scripted mock. Protocol 3 (core branch) plugs in through `ControlTransport` in adapter.ts.
 */
import type { SessionState } from '../../../src/protocol/index.ts';
import type { Outcome } from '../link.ts';

/** what this device may do on the computer: look, answer approvals, or also send prompts and start sessions (set on the computer, enforced there) */
export type Scope = 'observe' | 'answer' | 'control';
/** the computer's own kill switch for control: on, read only (no prompt, stop or start) or off */
export type ControlMode = 'on' | 'readonly' | 'off';
export type Status = 'working' | 'needs_you' | 'idle' | 'ended';

/** why a message box is disabled; every reason has plain words in views */
export type NoPrompt = 'harness' | 'scope' | 'bypass' | 'off' | 'readonly' | 'ended' | 'host_old' | 'paused';
export interface PromptCap { ok: boolean; /** the harness takes a message while it works (steering) */ queue?: boolean; why?: NoPrompt }
/** none: no Stop button; soft: stops at the next tool call (Claude Code); now: stops at once (OpenCode, hosted sessions) */
export type StopKind = 'none' | 'soft' | 'now';

export interface CSession {
  sid: string;
  /** agent kind id as in the protocol (claude-code, codex, opencode ...) */
  harness: string;
  /** the project folder name, never a terminal title */
  label: string;
  status: Status;
  since: number;
  mode: 'normal' | 'bypass' | 'unknown';
  model?: string | undefined;
  /** 1 to 5 */
  effort?: number | undefined;
  prompt: PromptCap;
  stop: StopKind;
  /** shown instead of the Stop button when `stop` is none */
  stopWhy?: string | undefined;
  /** the computer can send a live tail for this session */
  tail: boolean;
  /** how a message gets to the agent, in words ("through the Claude channel") */
  route?: string | undefined;
  /** the opaque reference the station uses for the robot of this session (the link `#/open/<ref>` carries it) */
  station?: string | undefined;
  /** the unmodified protocol state: pending request, last messages */
  state: SessionState;
}

export interface LaunchEntry {
  id: string;
  /** the project's name as the computer lists it (never a path) */
  project: string;
  harness: string;
  models: { id: string; label: string }[];
  efforts: { id: string; label: string }[];
  /** never includes a mode without approval prompts */
  modes: { id: string; label: string }[];
}

export interface ControlHost {
  name: string;
  conn: 'connecting' | 'online' | 'killed';
  online: boolean | null;
  /** the computer has sent its state at least once on this connection */
  ready: boolean;
  offlineSince?: number | undefined;
  scope: Scope;
  control: ControlMode;
  paused: boolean;
  away?: boolean | undefined;
  /** false: the computer's Companion does not know remote control (protocol 3) */
  supported: boolean;
  launch: LaunchEntry[];
}

/** `from`: the paired device that sent a `user` line, when the computer says */
export interface TailLine { kind: 'user' | 'assistant' | 'tool' | 'output' | 'note'; text: string; ts: number; from?: string | undefined }
export interface Tail {
  lines: TailLine[]; /** characters the computer cut */ cut?: number | undefined; updatedAt: number; outputShown: boolean;
  /** tool output is switched on or off at the computer, not from here: the page says how instead of offering a button that does nothing */
  revealOnComputer?: boolean | undefined;
}

export type SendOutcome =
  | 'sent' | 'applied' | 'started' | 'stale' | 'scope' | 'bypass' | 'harness' | 'too_long' | 'rate_limited' | 'paused' | 'control_off' | 'readonly'
  | 'offline' | 'expired' | 'needs_local' | 'stepup' | 'failed' | 'timeout' | 'unsupported'
  | 'keystroke_prefix' | 'gone' | 'project' | 'busy' | 'declined' | 'mode_not_allowed';
/** Stop reports twice: `stopping` while it waits, then the final word */
export type StopStage = 'stopping' | 'stopped' | 'stopped_now' | 'unconfirmed' | 'failed' | 'offline' | 'unsupported';

export interface AuditEvent { ts: number; kind: 'prompt' | 'interrupt' | 'start' | 'approve' | 'deny' | 'reply' | 'unlock' | 'refused'; target?: string | undefined; device: string; outcome: string; chars?: number | undefined; note?: string | undefined }

export interface StepUpAction {
  kind: 'prompt' | 'start' | 'answer';
  /** "Send a message to botwarren" */
  title: string;
  /** exactly the text that will be sent (shown in the sheet) */
  text?: string | undefined;
  /** "Claude Code · sonnet-5.5" */
  target?: string | undefined;
  /** start always asks again; a message uses the 15 minute window */
  fresh: boolean;
  /** what the assertion is bound to (the protocol's command kind and target); the page fills it in, the transport uses it */
  bind?: { kind: 'prompt' | 'start' | 'answer'; target: string } | undefined;
}
export type StepUpResult = 'ok' | 'cancelled' | 'unsupported' | 'failed';

export interface StartOptions { project: string; harness: string; model?: string | undefined; effort?: string | undefined; mode?: string | undefined; text?: string | undefined }

export interface ControlApi {
  host(): ControlHost;
  sessions(): CSession[];
  presets(): { id: string; label: string }[];
  onChange(fn: () => void): void;
  /** the live tail of a session, or null before the first frame */
  tail(sid: string): Tail | null;
  /** start receiving the tail of one session; returns the function that stops it */
  watch(sid: string): () => void;
  /** tool output in the tail: off by default, switched per session; the computer decides what it sends */
  setOutput(sid: string, on: boolean): void;
  answer(s: CSession, a: 'approve' | 'deny' | 'reply', opt?: string): Promise<Outcome | 'timeout' | 'offline'>;
  /** free text to a session (a prompt, or the free-text answer to a question) */
  prompt(s: CSession, text: string, asAnswer: boolean): Promise<SendOutcome>;
  stop(s: CSession, onStage: (st: StopStage) => void): Promise<StopStage>;
  start(launchId: string, o: StartOptions): Promise<SendOutcome>;
  audit(): Promise<AuditEvent[]>;
  stepUp: {
    unlockedUntil(): number; supported(): boolean; confirm(a: StepUpAction): Promise<StepUpResult>;
    /** this device has no fingerprint or face lock registered yet and the browser could offer one */
    canRegister?(): boolean;
    /** register one: the computer asks its owner at the keyboard first */
    register?(): Promise<{ ok: boolean; why?: string | undefined }>;
  };
  /** the device's name, for audit lines */
  deviceName(): string;
}

export const MAX_PROMPT_CHARS = 4000;
