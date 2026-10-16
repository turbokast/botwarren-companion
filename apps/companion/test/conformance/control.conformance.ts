/**
 * The control-adapter conformance suite (protocol 3, WP3): what EVERY adapter that claims a control capability must do, run against the adapter alone
 * (no host). An adapter that does not implement `ControlAdapter` is checked for honesty instead (it must claim nothing). WP4 (OpenCode) and WP9 (Claude
 * channel) add their adapter to `test/control.conformance.test.ts` with a driver that stands in for the tool.
 *
 * The suite checks what the HOST relies on: capabilities are declared truthfully, an unsupported call is `unsupported` and has no effect, an unknown
 * session is `gone`, the text the host handed over reaches the tool unchanged, a follow-up is only ever claimed for a command that was delivered, and tail
 * lines are plain strings of the declared kinds. Decisions (scope, step-up, limits) are the host's and are not tested here.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { asControlText } from '../../src/adapters/preset.ts';
import { isControlAdapter, type Adapter, type ControlAdapter, type ControlPrompt, type LaunchSpec, type NativeRef } from '../../src/adapters/types.ts';
import { ROUTES, TAIL_KINDS } from '../../src/protocol/index.ts';
import { recordingContext, type Recording } from '../support/recording-context.ts';

/** how the suite makes the "tool" do things and sees what reached it */
export interface ConformanceDriver {
  /** the tool has a session with this key (idle) */
  spawn(key: string): Promise<void> | void;
  /** the tool shows a question the adapter reports as pending; returns its native handle */
  question(key: string): Promise<NativeRef>;
  /** the tool prints a line (only meaningful when the adapter declares tail) */
  say(key: string, text: string): Promise<void> | void;
  /** what the tool actually received, in order */
  received(): { prompts: string[]; interrupts: number; answers: string[]; starts: LaunchSpec[] };
  /** the key the adapter knows the tool's session `name` ("s1", "s2") by; default: the name itself (an adapter whose keys have a fixed shape, like `opencode:ses...`, maps it) */
  keyOf?(name: string): string;
  /** the launch entry `startSession` is tried with (an adapter that only starts its own harness in a folder that exists needs its own); default: a generic one */
  launch?: LaunchSpec;
}

export interface ConformanceTarget {
  name: string;
  make(): Promise<{ adapter: Adapter; rec: Recording; driver: ConformanceDriver; /** stops what the tool stand-in holds (a fake server) */ close?: () => Promise<void> | void }>;
}

const who = { device: 'Suite phone' };
const prompt = (text: string): ControlPrompt => ({ text: asControlText(text), framed: asControlText(`[Botwarren Companion: message from the owner's paired device "Suite phone"]\n\n${text}`), from: 'Suite phone' });
const DEFAULT_LAUNCH: LaunchSpec = { id: 'suite', label: 'Suite project', harness: 'other', root: '/work/suite', mode: 'default' };
const settle = (ms = 80): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function describeControlConformance(t: ConformanceTarget): void {
  describe(`control conformance: ${t.name}`, () => {
    const open: (() => Promise<void> | void)[] = [];
    afterEach(async () => { for (const c of open.splice(0)) await c(); });
    const boot = async () => {
      const m = await t.make();
      open.push(async () => { await m.adapter.stop(); await m.close?.(); });
      await m.adapter.start(m.rec.ctx);
      const k = (n: string): string => m.driver.keyOf?.(n) ?? n;
      const launch = m.driver.launch ?? DEFAULT_LAUNCH;
      return { ...m, k, launch };
    };

    it('declares its control capabilities consistently', async () => {
      const { adapter } = await boot();
      const c = adapter.manifest.control;
      expect(ROUTES).toContain(c.route);
      for (const k of ['prompt', 'interrupt', 'softInterrupt', 'answer', 'start', 'tail'] as const) expect(typeof c[k], k).toBe('boolean');
      if (c.prompt || c.answer || c.start) expect(c.route, 'a tool that takes text has a route').not.toBe('none');
      if (!c.prompt && !c.answer && !c.start) expect(c.route, 'a tool that takes no text has no route').toBe('none');
      if (c.softInterrupt) expect(c.interrupt, 'softInterrupt means an interrupt exists').toBe(true);
      const any = c.prompt || c.interrupt || c.answer || c.start;
      if (any) expect(isControlAdapter(adapter), 'a control capability needs the ControlAdapter methods').toBe(true);
    });

    it('an adapter that claims nothing delivers nothing and reports no tail', async () => {
      const { adapter, rec, driver, k, launch } = await boot();
      if (isControlAdapter(adapter)) return;
      await driver.spawn('s1'); await driver.say('s1', 'hello'); await settle();
      expect(rec.tails).toEqual([]); expect(rec.followups).toEqual([]);
      expect(driver.received()).toEqual({ prompts: [], interrupts: 0, answers: [], starts: [] });
    });

    it('answers "unsupported" for every capability it does not declare, with no effect on the tool', async () => {
      const { adapter, driver, k, launch } = await boot();
      if (!isControlAdapter(adapter)) return;
      const c = adapter.manifest.control; const a = adapter as ControlAdapter;
      await driver.spawn('s1'); const q = await driver.question('s1').catch(() => null);
      const before = JSON.stringify(driver.received());
      if (!c.prompt) expect(await a.sendPrompt(k('s1'), prompt('x'), who)).toBe('unsupported');
      if (!c.interrupt) expect(await a.interrupt(k('s1'), who)).toBe('unsupported');
      if (!c.answer && q) expect(await a.answerText(q, asControlText('x'), who)).toBe('unsupported');
      if (!c.start) expect((await a.startSession(launch, null, who)).result).toBe('unsupported');
      if (!c.prompt && !c.interrupt && !c.answer && !c.start) expect(JSON.stringify(driver.received())).toBe(before);
    });

    it('delivers a prompt unchanged, to the session it was for only; an unknown session is "gone"', async () => {
      const { adapter, driver, k, launch } = await boot();
      if (!isControlAdapter(adapter) || !adapter.manifest.control.prompt) return;
      await driver.spawn('s1'); await driver.spawn('s2');
      expect(await adapter.sendPrompt(k('s1'), prompt('run the tests'), who)).toBe('delivered');
      const got = driver.received().prompts;
      expect(got).toHaveLength(1);
      expect(got[0]).toContain('run the tests'); // the host's text reaches the tool; the adapter adds nothing of its own to the user's part
      expect(await adapter.sendPrompt('nope', prompt('x'), who)).toBe('gone');
      expect(await adapter.sendPrompt('', prompt('x'), who)).toBe('gone');
      expect(driver.received().prompts).toHaveLength(1);
    });

    it('stops a session it knows, and says "gone" for one it does not', async () => {
      const { adapter, driver, k, launch } = await boot();
      if (!isControlAdapter(adapter) || !adapter.manifest.control.interrupt) return;
      await driver.spawn('s1');
      expect(await adapter.interrupt(k('s1'), who)).toBe('delivered');
      expect(driver.received().interrupts).toBe(1);
      expect(await adapter.interrupt('nope', who)).toBe('gone');
      expect(driver.received().interrupts).toBe(1);
    });

    it('delivers free text only to the question it was handed, and says "gone" for an unknown handle', async () => {
      const { adapter, driver, k, launch } = await boot();
      if (!isControlAdapter(adapter) || !adapter.manifest.control.answer) return;
      await driver.spawn('s1');
      const n = await driver.question('s1');
      expect(await adapter.answerText({ ...n, id: 'not-the-one' }, asControlText('main'), who)).toBe('gone');
      expect(driver.received().answers).toEqual([]);
      expect(await adapter.answerText(n, asControlText('main'), who)).toBe('delivered');
      expect(driver.received().answers).toEqual(['main']);
    });

    it('starts a session in the launch folder with the launch mode, and reports the key it will use', async () => {
      const { adapter, rec, driver, k, launch } = await boot();
      if (!isControlAdapter(adapter) || !adapter.manifest.control.start) return;
      const r = await adapter.startSession(launch, prompt('first task'), who);
      expect(r.result).toBe('delivered');
      expect(driver.received().starts).toEqual([launch]);
      if (r.sessionKey) { await settle(150); expect(rec.sessions.some((s) => s.key === r.sessionKey), 'the key it returned is the key it reports').toBe(true); }
    });

    it('claims a follow-up only for a command it delivered, for the right session, with a known meaning', async () => {
      const { adapter, rec, driver, k, launch } = await boot();
      if (!isControlAdapter(adapter)) return;
      await driver.spawn('s1'); await driver.spawn('s2');
      if (adapter.manifest.control.prompt) await adapter.sendPrompt(k('s1'), prompt('go'), who);
      if (adapter.manifest.control.interrupt) await adapter.interrupt(k('s2'), who);
      await settle(150);
      for (const f of rec.followups) { expect(['prompt', 'interrupt', 'answer']).toContain(f.what); expect([k('s1'), k('s2')]).toContain(f.key); }
      if (!adapter.manifest.control.prompt) expect(rec.followups.filter((f) => f.what === 'prompt')).toEqual([]);
      if (!adapter.manifest.control.interrupt) expect(rec.followups.filter((f) => f.what === 'interrupt')).toEqual([]);
      // unknown sessions never produce a follow-up
      await adapter.sendPrompt('nope', prompt('x'), who).catch(() => undefined); await settle(60);
      expect(rec.followups.some((f) => f.key === 'nope')).toBe(false);
    });

    it('reports tail lines as plain strings of the declared kinds, and none when it does not declare tail', async () => {
      const { adapter, rec, driver, k, launch } = await boot();
      await driver.spawn('s1'); await driver.say('s1', 'a line of output'); await settle(100);
      const items = rec.tails.flatMap((x) => x.items);
      if (!adapter.manifest.control.tail) { expect(items).toEqual([]); return; }
      expect(items.length).toBeGreaterThan(0);
      for (const it of items) { expect(TAIL_KINDS).toContain(it.k); expect(typeof it.text).toBe('string'); expect(Number.isFinite(it.ts)).toBe(true); }
    });

    it('does not throw on odd input', async () => {
      const { adapter } = await boot();
      if (!isControlAdapter(adapter)) return;
      for (const key of ['', ' ', 'a'.repeat(5000), '../../etc/passwd', '\u0000']) {
        await expect(adapter.sendPrompt(key, prompt('x'), who)).resolves.toMatch(/gone|unsupported|failed|busy/);
        await expect(adapter.interrupt(key, who)).resolves.toMatch(/gone|unsupported|failed|busy/);
      }
    });
  });
}
