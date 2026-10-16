/**
 * OpenAI Codex CLI as a hook-family tool. Facts and where they come from (docs/ADAPTERS.md 3.1; spike S-C1, fixtures in test/fixtures/codex/0.162.1):
 *  - the hook input and decision shapes are the ones captured from codex-cli 0.162.1 (test/fixtures/codex/0.162.1) and the hooks page of the Codex docs;
 *  - `PermissionRequest` runs before the dialog; allow skips the dialog and the command runs, deny shows "Blocked by hook: <message>" and the model reads the
 *    message; a hook that times out or errors shows the dialog (fail open to the local prompt);
 *  - the fields the hook may not return (`updatedInput`, `updatedPermissions`, `interrupt`) fail closed in Codex and are never produced here.
 * Licence: Apache-2.0.
 */
import { clip } from '../../../mask.ts';
import { NO_CONTROL, type AdapterManifest } from '../../types.ts';
import { commandRisks, patchFiles, patchRisks } from '../risk.ts';
import type { HookTool, ParsedHook, ToolView } from '../types.ts';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export const CODEX_ID = 'codex';
/** Codex versions the hook contract was verified on (spike S-C1: 0.162.1; patch releases of the same minor are assumed alike). Anything else is shown but not answerable. */
export const CODEX_VERIFIED = ['0.162.*'] as const;

export const CODEX_MANIFEST: AdapterManifest = {
  id: CODEX_ID, kind: 'codex', safety: 'B',
  caps: { detect: true, readPending: true, readRecent: true, approve: true, deny: true, presetReply: true, optionAnswer: false },
  reads: [
    'the hook events Codex sends to this companion: session start and end, your prompt events (not the prompt text), permission requests (the command or the files a patch names), tool-finished events (not their output), and the agent\'s last message when a turn ends',
    'nothing else: no files are read (Codex\'s transcript is not opened), and a tool\'s output is ignored',
    '`codex --version`, and for `codex doctor` the hook list Codex itself reports',
  ],
  verified: { versions: CODEX_VERIFIED },
  // deny is always allowed remotely; approvals follow your setting (the "risky" setting uses the hints: outside the project, network, destructive, protected files)
  confirmFloor: { approve: 'off', reply: 'off' },
  observesOutcome: true,
  // protocol 3: no control capability is verified for this tool yet (observe and approve/deny only), so none is claimed
  control: NO_CONTROL,
};

const EVENTS: Record<string, ParsedHook['kind']> = {
  SessionStart: 'start', SessionEnd: 'end', UserPromptSubmit: 'prompt', PermissionRequest: 'permission', Stop: 'idle', PostToolUse: 'post', Interrupt: 'interrupt',
};

export const codexTool: HookTool = {
  id: CODEX_ID, kind: 'codex', bin: 'codex', manifest: CODEX_MANIFEST,
  events: Object.keys(EVENTS),

  parse(event, input): ParsedHook | null {
    const kind = EVENTS[event];
    if (!kind) return null;
    const sessionId = str(input.session_id);
    if (!sessionId) return null;
    return {
      kind, sessionId, cwd: str(input.cwd), ...(str(input.turn_id) ? { turnId: str(input.turn_id) } : {}), ...(str(input.permission_mode) ? { permissionMode: str(input.permission_mode) } : {}),
      ...(str(input.tool_name) ? { tool: str(input.tool_name) } : {}), ...(input.tool_input !== undefined ? { toolInput: obj(input.tool_input) } : {}),
      ...(kind === 'idle' && str(input.last_assistant_message) ? { text: str(input.last_assistant_message) } : {}),
    };
  },

  view(h): ToolView {
    const tool = h.tool ?? 'tool'; const input = h.toolInput ?? {};
    if (tool === 'Bash') {
      const command = str(input.command);
      return { summary: clip(str(input.description) || 'Run a command', 200), preview: command, risk: commandRisks(command, h.cwd) };
    }
    if (tool === 'apply_patch') {
      // the patch body is source code and is not sent: only the names of the files it touches
      const patch = str(input.command) || str(input.input) || str(input.patch);
      const { files } = patchFiles(patch);
      return { summary: clip(str(input.description) || 'Apply a patch', 200), preview: files.length ? files.join('\n') : '(the files it changes are not listed)', risk: patchRisks(patch, h.cwd) };
    }
    // an MCP tool or one this version does not know: its name and its arguments in compact form (masked and capped by the session table)
    let args = ''; try { args = JSON.stringify(input); } catch { /* none */ }
    return { summary: `Use the ${tool} tool`, preview: args, risk: ['unknown_tool'] };
  },

  decision: (d) => ({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: d.behavior, ...(d.message ? { message: d.message } : {}) } } }),

  // exec mode and `approval_policy = "never"` report bypassPermissions (observed): there is nothing to approve
  bypass: (h) => h.permissionMode === 'bypassPermissions',

  // the permission event carries `description` and the later tool event does not: leave it out so both hash alike
  fingerprintInput(h) { const { description: _d, ...rest } = h.toolInput ?? {}; return rest; },
};
