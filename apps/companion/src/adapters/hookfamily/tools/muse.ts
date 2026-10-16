/**
 * Meta's Muse Code as a hook-family tool, through a plugin this companion generates (see installers/muse.ts). What was VERIFIED LIVE on Muse Code 1.4.9 in the lab
 * (a real, logged-in TUI driven in a pty with a real model; fixtures test/fixtures/muse/1.4.9, observed):
 *  - the hook input is Claude-shaped: hook_event_name, session_id, turn_id, cwd, transcript_path (null), model, model_provider, permission_mode, tool_name ("bash"),
 *    tool_input {command, description, workdir, sandbox_permissions?}; Stop has last_assistant_message; Notification has notification_type "permission_prompt" and
 *    the message "<folder> - waiting for approval" about 6 seconds after the request started to wait for a person;
 *  - PermissionRequest fires for EVERY call Muse evaluates, before it decides, and Muse resolves most of them itself within milliseconds (a sandboxed command ran, failed in
 *    the sandbox and moved on with no prompt). The request that really waited for a person carried sandbox_permissions "require_escalated". Muse also reports PostToolUse for
 *    its own helper tool `submit_reminder_decision` in separate sessions (ignored here);
 *  - a DENY from the hook works: Muse showed the block within about a second, the command did not run, the model was told;
 *  - an ALLOW from the hook does NOT approve an escalated request: Muse kept waiting on its own dialog (a Notification followed) and the command did not run. (Muse's binary
 *    says "a hook-supplied confirmation is not approval".) So this adapter can DENY from the phone but never offers Approve: `approveEffective: false`.
 *  - observed with the offline harness (`muse plugins hook test`): a decision carrying `updatedPermissions` is rejected, which this code never produces.
 * Holding is therefore limited to the requests that really wait (escalated ones), only while away, at most 45 s, then Muse's own dialog. Answering is pinned to the version
 * verified here (1.4.9); any other version is shown read-only (owner decision 8). Licence: Apache-2.0.
 */
import { clip } from '../../../mask.ts';
import { NO_CONTROL, type AdapterManifest } from '../../types.ts';
import { commandRisks, outsideWorkspace } from '../risk.ts';
import type { HookTool, ParsedHook, ToolView } from '../types.ts';
import type { RiskTag } from '../../types.ts';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const first = (o: Record<string, unknown>, ...keys: string[]): string => { for (const k of keys) { const v = str(o[k]); if (v) return v; } return ''; };

export const MUSE_ID = 'muse';

export const MUSE_MANIFEST: AdapterManifest = {
  id: MUSE_ID, kind: 'muse', safety: 'B',
  // deny and "deny and say" only: Muse ignores an approval that comes from a hook for the requests that wait for a person (verified live on 1.4.9)
  caps: { detect: true, readPending: true, readRecent: true, approve: false, deny: true, presetReply: true, optionAnswer: false },
  reads: [
    'the hook events Muse sends to the "botwarren-companion" plugin you install: session start and end, prompt events (not the prompt text), permission requests (the command or file the request names), tool-finished events (not their output), Muse\'s own "needs a human" notifications, and the agent\'s last message when a turn ends',
    'nothing else: no file is read (Muse\'s session files are not opened), and a tool\'s output is ignored',
    '`muse --version`, and for `muse doctor` the plugin list Muse itself reports',
  ],
  // answering (deny) is verified on this exact version; Muse updates itself, so any other version is read-only until it is verified again (`adapters verify muse <version>`)
  verified: { versions: ['1.4.9'] },
  // approvals cannot be given from here (see above); the floor is kept for a future version
  confirmFloor: { approve: 'risky', reply: 'off' },
  observesOutcome: true,
  // protocol 3: no control capability is verified for this tool yet (observe and approve/deny only), so none is claimed
  control: NO_CONTROL,
};

const EVENTS: Record<string, ParsedHook['kind']> = {
  SessionStart: 'start', SessionEnd: 'end', UserPromptSubmit: 'prompt', PermissionRequest: 'permission', Stop: 'idle', PostToolUse: 'post', PostToolUseFailure: 'post', Notification: 'notification', Interrupt: 'interrupt',
};

export const museTool: HookTool = {
  id: MUSE_ID, kind: 'muse', bin: 'muse', manifest: MUSE_MANIFEST,
  events: Object.keys(EVENTS),

  parse(event, input): ParsedHook | null {
    const kind = EVENTS[event];
    if (!kind) return null;
    // a PermissionRequest that dispatched after the turn already ended is stale (Muse's own Herdr plugin skips it the same way)
    if (kind === 'permission' && input.post_stop === true) return null;
    // Muse's own internal helper tools (the reminder subagent runs in its own session and reports PostToolUse for `submit_reminder_decision`) are not the person's session
    if (first(input, 'tool_name', 'toolName') === 'submit_reminder_decision') return null;
    const sessionId = first(input, 'session_id', 'sessionId');
    if (!sessionId) return null;
    const tool = first(input, 'tool_name', 'toolName');
    const ti = input.tool_input ?? input.toolInput;
    return {
      kind, sessionId, cwd: first(input, 'cwd', 'workspace'), ...(first(input, 'turn_id', 'turnId') ? { turnId: first(input, 'turn_id', 'turnId') } : {}),
      ...(first(input, 'permission_mode', 'permissionMode') ? { permissionMode: first(input, 'permission_mode', 'permissionMode') } : {}),
      ...(tool ? { tool } : {}), ...(ti !== undefined ? { toolInput: obj(ti) } : {}),
      ...(kind === 'idle' ? (first(input, 'last_assistant_message', 'lastAssistantMessage') ? { text: first(input, 'last_assistant_message', 'lastAssistantMessage') } : {}) : {}),
      ...(kind === 'notification' ? { text: first(input, 'message', 'title'), ...(first(input, 'notification_type') ? { notificationType: first(input, 'notification_type') } : {}) } : {}),
    };
  },

  view(h): ToolView {
    const tool = h.tool ?? 'tool'; const input = h.toolInput ?? {};
    const risk = new Set<RiskTag>();
    // Muse's own signals, if the hook carries them (not seen in the live recordings; kept defensively) (the MSP request has `protectedWrite` and `judgeEscalated`): shown, and they count for "risky"
    if (input.protectedWrite === true || input.protected_write === true) risk.add('protected_write');
    if (input.judgeEscalated === true || input.judge_escalated === true) risk.add('escalated');
    const command = first(input, 'command', 'cmd');
    const path = first(input, 'file_path', 'path', 'filePath');
    if (command) {
      for (const r of commandRisks(command, h.cwd)) risk.add(r);
      return { summary: clip(first(input, 'description', 'justification') || 'Run a command', 200), preview: command, risk: [...risk] };
    }
    if (path) {
      if (outsideWorkspace(h.cwd, path)) risk.add('outside_workspace');
      return { summary: clip(first(input, 'description') || `Use the ${tool} tool on a file`, 200), preview: path, risk: [...risk] };
    }
    let args = ''; try { args = JSON.stringify(input); } catch { /* none */ }
    risk.add('unknown_tool');
    return { summary: `Use the ${tool} tool`, preview: args, risk: [...risk] };
  },

  decision: (d) => ({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: d.behavior, ...(d.message ? { message: d.message } : {}) } } }),

  // observed on Muse 1.4.9 (lab): PermissionRequest fires for every evaluated call and most resolve at once (a sandboxed command ran and failed with no prompt); the one that
  // really waited for a person carried sandbox_permissions "require_escalated" and was followed 6 s later by a Notification "waiting for approval"
  approveEffective: false,
  holdable: (h) => str(h.toolInput?.sandbox_permissions) === 'require_escalated',

  bypass: (h) => ['bypassPermissions', 'allowAll', 'never', 'yolo'].includes(h.permissionMode ?? ''),

  fingerprintInput(h) { const { description: _d, justification: _j, ...rest } = h.toolInput ?? {}; return rest; },
};
