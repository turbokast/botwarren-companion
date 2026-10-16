/**
 * Builds a `ControlApi` from the real link. Today's computers (protocol 1 and 2) can do approvals only, so everything else answers honestly:
 * no prompt, no stop, no start, no tail, "your computer's Companion is too old". The protocol 3 commands (prompt, interrupt, start, watch, history,
 * audit and the step-up assertion) are reached through an optional `ControlTransport`; the core branch (feat/remote-control-core) supplies it and the
 * screens need no change when it does. Nothing here invents data: a field the computer did not send is left out.
 */
import type { SessionState } from '../../../src/protocol/index.ts';
import type { Link } from '../link.ts';
import type { AuditEvent, CSession, ControlApi, ControlHost, LaunchEntry, NoPrompt, Scope, SendOutcome, StartOptions, StepUpResult, StopKind, StopStage, Tail } from './types.ts';

/** what protocol 3 adds. Every method is optional: a transport that lacks one means "not supported" for that command. */
export interface ControlTransport {
  /** the computer's control state: scope for this device, the kill switch, the launch table */
  host(): { scope: Scope; control: 'on' | 'readonly' | 'off'; launch: LaunchEntry[] } | null;
  /** per-session extras the computer sends with protocol 3 */
  extras(sid: string): { model?: string; effort?: number; prompt?: { ok: boolean; queue?: boolean; why?: NoPrompt }; stop?: StopKind; stopWhy?: string; tail?: boolean; route?: string; station?: string } | null;
  tail?(sid: string): Tail | null;
  watch?(sid: string): () => void;
  setOutput?(sid: string, on: boolean): void;
  prompt?(sid: string, text: string, asAnswer: boolean): Promise<SendOutcome>;
  interrupt?(sid: string, onStage: (st: StopStage) => void): Promise<StopStage>;
  start?(launchId: string, o: StartOptions): Promise<SendOutcome>;
  audit?(): Promise<AuditEvent[]>;
  stepUp?: ControlApi['stepUp'];
  onChange?(fn: () => void): void;
}

const statusOf = (s: SessionState): CSession['status'] => (s.pending ? 'needs_you' : s.status === 'working' ? 'working' : s.status === 'ended' ? 'ended' : 'idle');

export function fromLink(link: Link, transport?: ControlTransport): ControlApi {
  let offlineSince: number | undefined;
  const listeners: (() => void)[] = [];
  link.onChange(() => { for (const l of listeners) l(); });
  transport?.onChange?.(() => { for (const l of listeners) l(); });

  const host = (): ControlHost => {
    if (link.hostOnline === false) offlineSince ??= Date.now(); else offlineSince = undefined;
    const st = link.state;
    const t = transport?.host() ?? null;
    return {
      name: st?.host.name ?? link.name, conn: link.conn === 'online' ? 'online' : link.conn === 'killed' ? 'killed' : 'connecting', online: link.hostOnline, ready: !!st, offlineSince,
      scope: t?.scope ?? 'answer', control: t?.control ?? 'off', paused: st?.host.paused ?? false, away: st?.host.away, supported: !!t, launch: t?.launch ?? [],
    };
  };

  const sessions = (): CSession[] => (link.state?.sessions ?? []).map((s) => {
    const x = transport?.extras(s.sid) ?? null;
    const bypass = s.mode === 'bypass';
    const prompt = x?.prompt ?? { ok: false, why: (bypass ? 'bypass' : transport ? 'harness' : 'host_old') as NoPrompt };
    return {
      sid: s.sid, harness: s.agent, label: s.label, status: statusOf(s), since: s.since, mode: s.mode === 'bypass' ? 'bypass' : s.mode === 'normal' ? 'normal' : 'unknown',
      model: x?.model, effort: x?.effort, prompt, stop: x?.stop ?? 'none', stopWhy: x?.stopWhy ?? (transport ? undefined : 'This computer\'s Companion is too old for Stop. Update it on your computer.'),
      tail: x?.tail ?? false, route: x?.route, station: x?.station, state: s,
    };
  });

  const noStepUp = { unlockedUntil: () => 0, supported: () => false, confirm: async (): Promise<StepUpResult> => 'unsupported' };
  return {
    host, sessions,
    presets: () => link.state?.presets ?? [],
    onChange: (fn) => { listeners.push(fn); },
    tail: (sid) => transport?.tail?.(sid) ?? null,
    watch: (sid) => transport?.watch?.(sid) ?? ((): void => undefined),
    setOutput: (sid, on) => { transport?.setOutput?.(sid, on); },
    answer: (s, a, opt) => {
      const p = s.state.pending;
      if (!p) return Promise.resolve('stale');
      return link.act(s.sid, p, a, opt);
    },
    prompt: async (s, text, asAnswer) => (transport?.prompt ? transport.prompt(s.sid, text, asAnswer) : 'unsupported'),
    stop: async (s, onStage) => { if (!transport?.interrupt) { onStage('unsupported'); return 'unsupported'; } return transport.interrupt(s.sid, onStage); },
    start: async (id, o) => (transport?.start ? transport.start(id, o) : 'unsupported'),
    audit: async () => (transport?.audit ? transport.audit() : []),
    stepUp: transport?.stepUp ?? noStepUp,
    deviceName: () => link.name,
  };
}
