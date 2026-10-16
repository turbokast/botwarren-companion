import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface Fixture { tool: string; version: string; captured: string; source: 'observed' | 'doc' | 'harness'; how: string; event: string; input: Record<string, unknown> }

/** a recorded hook input: test/fixtures/<tool>/<version>/<name>.json, each with its provenance (how it was captured, or the doc it was written from) */
export function fixture(tool: string, version: string, name: string): Fixture {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${tool}/${version}/${name}.json`, import.meta.url)), 'utf8')) as Fixture;
}

/** the fixture's input with some fields replaced (a different command, another session) */
export function withInput(f: Fixture, patch: Record<string, unknown>): Record<string, unknown> { return { ...f.input, ...patch }; }
