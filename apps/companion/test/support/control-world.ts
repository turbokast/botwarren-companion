/**
 * A world for the remote-control tests: the real relay and daemon, a scripted fake harness registered as a control adapter, a protocol 3 simulated phone
 * with scope `control`, remote control switched on, and a controllable "person at the computer" (the local confirmer).
 */
import { startWorld, type World } from '../world.ts';
import { SimDevice } from '../simdevice.ts';
import { FakeHarness, type HarnessOptions } from './fake-harness/index.ts';
import { VirtualAuthenticator, type Alg } from './virtual-authenticator.ts';
import { b64u, CAP_LONG, type Scope, type SuResultData } from '../../src/protocol/index.ts';
import { relyingPartyOf } from '../../src/stepup.ts';
import { sessionBind } from '../../src/sessions.ts';
import type { LocalConfirmRequest } from '../../src/host.ts';

export interface ControlWorld {
  w: World;
  fake: FakeHarness;
  phone: SimDevice;
  /** what the person at the computer has been asked, in order */
  asked: LocalConfirmRequest[];
  /** what the person answers (default yes) */
  person: { answer: boolean };
  /** a session of the fake harness: its key, host session id, and the bind the phone has been shown for it */
  session(key?: string, o?: { cwd?: string; mode?: 'normal' | 'bypass' | 'unknown'; harness?: FakeHarness }): Promise<{ key: string; sid: string; bind: () => Promise<string> }>;
  setControl(patch: Record<string, unknown>): void;
  rp: { rpId: string; origin: string };
  authenticator(alg?: Alg): VirtualAuthenticator;
  /** register the authenticator as this phone's step-up credential (the person says yes at the computer) */
  register(auth: VirtualAuthenticator, dev?: SimDevice): Promise<void>;
  unlock(auth: VirtualAuthenticator, dev?: SimDevice): Promise<SuResultData>;
  close(): Promise<void>;
}

export const LAUNCH = [{ id: 'dragons', label: 'Dragon game', harness: 'other', root: '/work/dragon-game', modes: ['default', 'plan'] }];

export async function controlWorld(o: { harness?: HarnessOptions; world?: Parameters<typeof startWorld>[0]; mode?: 'on' | 'readonly' | 'off'; scope?: Scope; proto?: number; control?: Record<string, unknown> } = {}): Promise<ControlWorld> {
  // the relay's per-connection frame limit (2 a second) is lifted for the functional tests; the churn test runs with the production limits
  const w = await startWorld({ stateGapMs: 5, tailGapMs: 30, resolveWaitMs: 400, relay: { rates: { connBurst: 100_000, connPerSec: 100_000, acctBurst: 100_000, acctPerSec: 100_000 } }, ...(o.world ?? {}) });
  const fake = new FakeHarness(o.harness);
  w.daemon.host.hub.register(fake);
  const cfg = w.daemon.store.config();
  cfg.maxActionsPerMinute = 60; cfg.maxActionsPerHour = 600; // the limits have their own tests (the defaults are small)
  cfg.control = { ...cfg.control, mode: o.mode ?? 'on', launch: LAUNCH as never, promptsPerMinute: 60, promptsPerHour: 200, startsPerMinute: 30, startsPerHour: 100, ...(o.control ?? {}) } as never;
  w.daemon.store.saveConfig(cfg);
  const asked: LocalConfirmRequest[] = [];
  const person = { answer: true };
  w.daemon.hub.watch((cid, req) => { asked.push(req); queueMicrotask(() => w.daemon.hub.decide(cid, person.answer)); });
  const phone = await w.pairDevice('Sim phone', { caps: [CAP_LONG], proto: o.proto ?? 3 });
  w.daemon.host.setDeviceScope(phone.id.id, o.scope ?? 'control');
  const rp0 = relyingPartyOf(w.base)!;
  const rp = { rpId: rp0.rpId, origin: rp0.origins[0]! };

  const cw: ControlWorld = {
    w, fake, phone, asked, person, rp,
    async session(key = `fake-${Math.random().toString(36).slice(2, 8)}`, so = {}) {
      (so.harness ?? fake).spawn(key, { ...(so.cwd ? { cwd: so.cwd } : {}), ...(so.mode ? { mode: so.mode } : {}) });
      const s = await waitFor(() => w.daemon.host.sessions.byKey(key));
      const sid = s.sid;
      // the phone has been shown this session (its ctl arrived)
      try { await phone.waitFor(() => phone.latest?.sessions.find((x) => x.sid === sid)?.ctl); } catch (e) {
        throw new Error(`the phone never saw the session (states ${phone.states.length}, last has ${JSON.stringify(phone.latest?.sessions.map((x) => [x.sid, !!x.ctl]))}, host has ${[...w.daemon.host.sessions.sessions.values()].map((x) => x.sid)}, online ${phone.online}, relay ${w.daemon.host.relayState}, audit ${w.daemon.store.auditTail(5).join(' | ')}): ${String(e)}`);
      }
      return {
        key, sid,
        bind: async () => {
          const want = sessionBind(w.daemon.host.sessions.bySid(sid)!);
          const seen = await phone.waitFor(() => phone.latest?.sessions.find((x) => x.sid === sid)?.ctl?.bind === want && want);
          return seen;
        },
      };
    },
    setControl(patch) { const c = w.daemon.store.config(); c.control = { ...c.control, ...patch } as never; w.daemon.store.saveConfig(c); w.daemon.host.configChanged(); },
    authenticator: (alg = -7) => new VirtualAuthenticator({ alg, rpId: rp.rpId, origin: rp.origin }),
    async register(auth, dev = phone) {
      const n = dev.suRegChallenges.length; const r = dev.suRegResults.length;
      await dev.send('su_regbegin', {});
      const c = await dev.waitFor(() => dev.suRegChallenges[n]);
      const m = auth.create(c.ch);
      await dev.send('su_reg', { ch: c.ch, ...m });
      const res = await dev.waitFor(() => dev.suRegResults[r]);
      if (!res.ok) throw new Error(`registration refused: ${res.why}`);
      await new Promise((ok) => setTimeout(ok, 30));
    },
    async unlock(auth, dev = phone) {
      const n = dev.suChallenges.length; const r = dev.suResults.length;
      await dev.send('su_begin', { for: 'unlock' });
      const first = await dev.waitFor(() => dev.suChallenges[n] ?? (dev.suResults[r] ? 'result' : undefined));
      if (first === 'result') return dev.suResults[r]!;
      const c = first as (typeof dev.suChallenges)[number];
      const m = auth.get(c.ch);
      await dev.send('su_assert', { ch: c.ch, ...m });
      return dev.waitFor(() => dev.suResults[r]);
    },
    async close() { await w.close(); },
  };
  return cw;
}

export async function waitFor<T>(fn: () => T | undefined | false | null, ms = 5000): Promise<T> {
  const t0 = Date.now();
  for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 15)); }
}
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
export { b64u };
