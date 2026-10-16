/** The per-tool part of the hook family: how one tool's hook input is read and how its decision is written. Licence: Apache-2.0. */
import type { AdapterManifest, AgentKind, RiskTag } from '../types.ts';

export type HookKind = 'start' | 'end' | 'prompt' | 'permission' | 'idle' | 'post' | 'interrupt' | 'notification';

export interface ParsedHook {
  kind: HookKind;
  /** the tool's own session id */
  sessionId: string;
  cwd: string;
  turnId?: string;
  /** the tool's permission mode, as it says it */
  permissionMode?: string;
  tool?: string;
  toolInput?: Record<string, unknown>;
  /** idle: the agent's last message; notification: its text */
  text?: string;
  /** notification: the kind the tool says (`permission_prompt`, `question_prompt`) */
  notificationType?: string;
}

export interface ToolView { summary: string; preview: string; risk: RiskTag[] }

export interface HookTool {
  readonly id: string;
  readonly kind: AgentKind;
  /** the command line `<bin> --version` (fixed) */
  readonly bin: string;
  readonly manifest: AdapterManifest;
  /** the events this tool sends, by the name its hook command receives */
  readonly events: readonly string[];
  /** reads the hook's stdin JSON; null for an event or shape it does not know (ignored, never an error) */
  parse(event: string, input: Record<string, unknown>): ParsedHook | null;
  /** what the phone shows for a permission request */
  view(h: ParsedHook): ToolView;
  /** the tool's own JSON for an allow or a deny (the shape it documents; nothing wider than "once" exists in it) */
  decision(d: { behavior: 'allow' | 'deny'; message?: string }): Record<string, unknown>;
  /**
   * Can this request be held for a phone answer? (default: yes). Muse fires PermissionRequest for EVERY tool call it evaluates and resolves most of them itself within
   * milliseconds, so holding them all would delay every tool call: only a request the tool says needs a human may be held.
   */
  holdable?(h: ParsedHook): boolean;
  /**
   * false: the tool ignores an allow that comes from a hook for the requests that matter (observed for Muse 1.4.9: an escalated request stayed on its own
   * dialog after the hook allowed it). Such a request can only be DENIED from the phone; `can.approve` is never offered.
   */
  readonly approveEffective?: boolean;
  /** the session runs without approval prompts */
  bypass(h: ParsedHook): boolean;
  /** a stable fingerprint input for the tool call that a PostToolUse can reproduce (leave out fields that only the permission event carries) */
  fingerprintInput(h: ParsedHook): unknown;
}
