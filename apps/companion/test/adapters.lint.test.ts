/**
 * Static rules for adapter code (docs/ADAPTERS.md 6.2): an adapter has no network access of its own, imports nothing from the crypto,
 * relay or store modules, cannot make text for an agent, and every `reads` line it declares is plain words. The host-side wiring (hub, builtin list,
 * the `io.ts` helpers, the types and `preset.ts`) is the exception and is listed by name.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_MANIFESTS } from '../src/adapters/builtin.ts';

const root = fileURLToPath(new URL('../src/adapters/', import.meta.url));
const HOST_SIDE = new Set(['hub.ts', 'builtin.ts', 'io.ts', 'types.ts', 'preset.ts']);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []; });
}
const files = walk(root).map((p) => ({ rel: relative(root, p).replace(/\\/g, '/'), text: readFileSync(p, 'utf8') }));
const adapterCode = files.filter((f) => !HOST_SIDE.has(f.rel));
const importsOf = (text: string): { spec: string; typeOnly: boolean }[] =>
  [...text.matchAll(/^\s*(?:import|export)\s+(type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm)].map((m) => ({ spec: m[2]!, typeOnly: !!m[1] }));

describe('adapter code', () => {
  it('has files to check', () => { expect(adapterCode.length).toBeGreaterThan(3); });

  it('imports no network, process or socket module: only io.ts may reach the machine', () => {
    const banned = /^(?:node:)?(?:net|http|https|http2|tls|dgram|dns|child_process|worker_threads|cluster)$/;
    for (const f of adapterCode) for (const i of importsOf(f.text)) expect(banned.test(i.spec), `${f.rel} imports ${i.spec}`).toBe(false);
    for (const f of adapterCode) expect(/\bfetch\s*\(|XMLHttpRequest|WebSocket\s*\(|process\.binding|require\s*\(/.test(f.text), `${f.rel} uses a global network call`).toBe(false);
  });

  it('imports nothing from the crypto, relay, link, store or host modules (types excepted), and not preset.ts', () => {
    const banned = /(?:^|\/)(?:store|host|webpush|link\/[a-z]+|protocol\/(?:hpke|keys|envelope|certs|pairing|bytes))\.ts$|(?:^|\/)preset\.ts$/;
    for (const f of adapterCode) for (const i of importsOf(f.text)) {
      if (i.typeOnly) continue;
      expect(banned.test(i.spec) || /\.\.\/(?:\.\.\/)*protocol\/index\.ts$/.test(i.spec), `${f.rel} imports ${i.spec}`).toBe(false);
    }
  });

  it('cannot widen an answer: the closed answer type has no scope, and no adapter source names a wider decision', () => {
    const types = readFileSync(join(root, 'types.ts'), 'utf8');
    const answer = /export type Answer =([\s\S]*?);\n\n/.exec(types)![1]!.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(answer).not.toMatch(/always|session|persist|amend|updatedInput|updatedPermissions|scope|remember|key/i);
    // wire words that would widen a decision in some tool; they appear nowhere in the code that builds a decision
    for (const f of adapterCode.filter((x) => /tools\/|family\.ts|installers\//.test(x.rel) || /opencode|muse/.test(x.rel))) {
      const code = f.text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''); // comments may say what is never sent
      expect(code, f.rel).not.toMatch(/acceptForSession|acceptWithExecpolicyAmendment|approvedForSession|localPersistent|updatedPermissions|updatedInput|'always'|"always"/);
    }
  });
});

describe('manifests', () => {
  it('every adapter declares what it reads, plainly, and a local confirmation floor', () => {
    for (const m of ALL_MANIFESTS) {
      expect(m.reads.length, m.id).toBeGreaterThan(0);
      for (const r of m.reads) expect(r.length, `${m.id}: ${r}`).toBeGreaterThan(20);
      expect(['off', 'risky', 'always']).toContain(m.confirmFloor.approve);
      // an adapter that cannot answer must not claim it can
      if (!m.caps.approve && !m.caps.deny) expect(m.caps.presetReply || m.caps.optionAnswer, m.id).toBe(false);
      // keystroke injection is not built (decision 1): nothing is rated C
      expect(m.safety, m.id).not.toBe('C');
    }
  });
});
