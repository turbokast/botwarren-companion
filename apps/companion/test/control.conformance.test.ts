import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeControlConformance, type ConformanceDriver } from './conformance/control.conformance.ts';
import { FakeHarness, type HarnessOptions } from './support/fake-harness/index.ts';
import { recordingContext } from './support/recording-context.ts';
import { ALL_MANIFESTS, builtinAdapters } from '../src/adapters/builtin.ts';
import { NO_CONTROL, isControlAdapter, type LaunchSpec, type NativeRef } from '../src/adapters/types.ts';
import { OpenCodeAdapter, OPENCODE_MANIFEST } from '../src/adapters/opencode/adapter.ts';
import { fakeOpenCode } from './support/fake-opencode.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const driverFor = (h: FakeHarness): ConformanceDriver => ({
  spawn: (key) => { h.spawn(key); },
  question: (key) => h.askQuestion(key),
  say: (key, text) => h.say(key, text),
  received: () => ({ prompts: h.received.prompts.map((p) => p.framed), interrupts: h.received.interrupts.length, answers: h.received.answers.map((a) => a.text), starts: h.received.starts.map((s) => s.launch) }),
});
const fakeTarget = (name: string, o: HarnessOptions) => ({
  name,
  make: async () => { const adapter = new FakeHarness({ followupMs: 5, ...o }); const rec = recordingContext(); return { adapter, rec, driver: driverFor(adapter) }; },
});

// the scripted fake: every capability, a keystroke route with only prompt, and nothing at all
describeControlConformance(fakeTarget('fake harness (everything)', {}));
describeControlConformance(fakeTarget('fake harness (keystroke route, prompt only)', { control: { interrupt: false, answer: false, start: false, tail: false, route: 'keys' } }));
describeControlConformance(fakeTarget('fake harness (soft interrupt, hook route)', { control: { prompt: false, answer: false, start: false, softInterrupt: true, route: 'none' } }));
describeControlConformance(fakeTarget('fake harness (nothing)', { control: { prompt: false, interrupt: false, answer: false, start: false, tail: false, route: 'none' } }));

// OpenCode (WP4): the real adapter against a faithful local fake of the OpenCode v2 HTTP API (shapes recorded from a real 2.0.21 in the lab); the driver only
// plays the tool's part (a session appears, a form is asked, the assistant prints a line) and reports what the SERVER received.
const OC_PASS = 'BW_TEST_OC_CONFORMANCE';
const ocTarget = {
  name: 'OpenCode v2 adapter (fake local server)',
  make: async () => {
    const oc = await fakeOpenCode();
    const root = mkdtempSync(join(tmpdir(), 'bwc-ocroot-'));
    const adapter = new OpenCodeAdapter({ env: { [OC_PASS]: oc.password! } });
    const rec = recordingContext();
    rec.ctx.config = () => ({ enabled: true, hold: 'never', holdSeconds: 30, port: oc.port, passwordEnv: OC_PASS });
    const id = (n: string): string => `ses_conf${n}0000`;
    const launch: LaunchSpec = { id: 'suite', label: 'Suite project', harness: 'opencode', root, mode: 'default' };
    const driver: ConformanceDriver = {
      keyOf: (n) => `opencode:${id(n)}`,
      launch,
      spawn: async (n) => { oc.sessions.push({ id: id(n), dir: root }); await adapter.poll(); },
      question: async (n) => {
        oc.forms.push({ id: `frm_conf${n}00000`, sessionID: id(n), title: 'Which branch should I use?', dir: root, fields: [{ key: 'branch', type: 'string' }] });
        await adapter.poll();
        const p = rec.pendings.filter((x) => x.kind === 'question' && x.sessionKey === `opencode:${id(n)}`).at(-1);
        return p!.native as NativeRef;
      },
      say: async (n, text) => { oc.assistant(id(n), [{ type: 'text', text }]); await adapter.poll(); },
      received: () => ({
        prompts: oc.prompts.map((p) => (p.body as { text: string }).text),
        interrupts: oc.interrupts.length,
        answers: oc.formReplies.map((r) => String(Object.values((r.body as { answer: Record<string, unknown> }).answer)[0])),
        starts: oc.created.map((b) => ({ ...launch, mode: (b as { agent?: string }).agent === 'plan' ? 'plan' as const : 'default' as const, root: (b as { location: { directory: string } }).location.directory })),
      }),
    };
    return { adapter, rec, driver, close: async () => { await oc.close(); rmSync(root, { recursive: true, force: true }); } };
  },
};
describeControlConformance(ocTarget);

describe('the built-in adapters declare their control capabilities honestly', () => {
  const CONTROLLED = new Set(['opencode', 'claude-code']); // WP4 (OpenCode, route api), WP9 (Claude Code, route channel); WP10 (Herdr) adds its own here, each with a conformance run
  it('claims no control capability except where one was verified and has its own conformance run', () => {
    for (const m of ALL_MANIFESTS) if (!CONTROLLED.has(m.id)) expect(m.control, m.id).toEqual(NO_CONTROL);
    // Claude Code (WP9): exactly what the conformance run and the lab back, nothing more
    expect(ALL_MANIFESTS.find((m) => m.id === 'claude-code')!.control).toEqual({ prompt: true, interrupt: true, softInterrupt: true, answer: true, start: false, tail: true, route: 'channel' });
  });

  it('only the adapters that claim control implement the control methods, so the host can route nothing to the others', () => {
    for (const a of builtinAdapters(null as never, {})) expect(isControlAdapter(a), a.manifest.id).toBe(CONTROLLED.has(a.manifest.id));
  });

  it('OpenCode claims exactly what was exercised in the lab: prompt, interrupt (hard, not soft), a one-line answer, start and tail, through the API', () => {
    expect(OPENCODE_MANIFEST.control).toEqual({ prompt: true, interrupt: true, softInterrupt: false, answer: true, start: true, tail: true, route: 'api' });
  });

  it('the Herdr adapter\'s source cannot type into a pane: its call allowlist has no prompt or key route', () => {
    const src = readFileSync(fileURLToPath(new URL('../src/adapters/herdr/adapter.ts', import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    expect(src).not.toMatch(/agent\.prompt|send_keys|pane\.run|agent\.send/);
  });

  it('the OpenCode adapter\'s source has the prompt, interrupt, session-create and form-reply routes and no shell, command, terminal, file or credential route', () => {
    const dir = fileURLToPath(new URL('../src/adapters/opencode/', import.meta.url));
    const src = readdirSync(dir).filter((n) => n.endsWith('.ts')).map((n) => readFileSync(join(dir, n), 'utf8')).join('\n').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    expect(src).toMatch(/\/prompt/); expect(src).toMatch(/\/interrupt/); expect(src).toMatch(/\/form\//);
    expect(src).not.toMatch(/\/shell|\/command|\/pty|\/api\/fs|\/worktree|\/api\/config|\/credential|\/integration|\/synthetic|\/revert|\/fork|\/move|\/compact|prompt_async|\/abort|\/api\/rpc/);
    expect(src).not.toMatch(/'always'|"always"|always:/);
  });
});

describe('adapters cannot make text for an agent, including the new control text', () => {
  const root = fileURLToPath(new URL('../src/adapters/', import.meta.url));
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []; });
  const HOST_SIDE = new Set(['hub.ts', 'builtin.ts', 'io.ts', 'types.ts', 'preset.ts']);
  it('no adapter source imports preset.ts or builds a ControlText', () => {
    for (const p of walk(root)) {
      const rel = relative(root, p).replace(/\\/g, '/');
      if (HOST_SIDE.has(rel)) continue;
      const text = readFileSync(p, 'utf8');
      expect(text, rel).not.toMatch(/asControlText|asPreset|as ControlText/);
    }
  });
});
