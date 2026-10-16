/**
 * The live tail of a session (protocol 3, WP5): what an adapter reports is cleaned, masked, bounded and kept in a small in-memory ring per session.
 * Nothing here is ever written to disk. The text that leaves this module is PLAIN TEXT: terminal escapes, control and bidi characters are removed and
 * secret shapes and the home folder are masked, but nothing is made safe to interpret (the client renders it with textContent and never acts on it).
 * Licence: Apache-2.0.
 */
import type { TailEntry, TailKind } from './protocol/index.ts';
import { maskSecrets } from './mask.ts';
import { cleanText } from './textclean.ts';

/** most lines kept per session, and most bytes of their text */
export const TAIL_MAX_ENTRIES = 300;
export const TAIL_MAX_BYTES = 256 * 1024;
/** characters one line may have, by kind (a longer one is cut at the END and the cut is reported) */
export const TAIL_LINE_LIMIT: Readonly<Record<TailKind, number>> = { assistant: 4000, user: 4000, tool: 300, tool_out: 2000, note: 200 };
/** the most of one reported text that is even looked at (cleaning and masking a megabyte of output would be a way to stall the computer) */
const PRE_CUT_CHARS = 24_000;
const ENTRY_OVERHEAD = 48;

const codePoints = (s: string): number => { let n = 0; for (const _ of s) n++; return n; };

/** replaces the home folder with `~` and the session's folder with `.`, longest first (a path is not a secret, but the owner need not see or share it in full) */
export function maskPaths(text: string, roots: readonly { path: string; as: string }[]): string {
  let out = text;
  for (const r of [...roots].filter((x) => x.path.length > 2 && x.path !== '/').sort((a, b) => b.path.length - a.path.length)) out = out.split(r.path).join(r.as);
  return out;
}

export interface TailSanitizeOptions { secrets: readonly string[]; roots: readonly { path: string; as: string }[] }

/** one reported text to the text that may be stored and sent: cleaned, masked, cut to the limit for its kind (never empty-after-cleaning: returns null then) */
export function sanitizeTail(k: TailKind, raw: string, o: TailSanitizeOptions): { text: string; cut: number; masked: number } | null {
  if (typeof raw !== 'string') return null;
  let pre = 0;
  let s = raw;
  if (s.length > PRE_CUT_CHARS) { const a = Array.from(s); if (a.length > PRE_CUT_CHARS) { pre = a.length - PRE_CUT_CHARS; s = a.slice(0, PRE_CUT_CHARS).join(''); } }
  const cleaned = cleanText(s).replace(/\n{3,}/g, '\n\n').trim();
  if (!cleaned) return null;
  const m = maskSecrets(cleaned, o.secrets);
  const text = maskPaths(m.text, o.roots);
  const limit = TAIL_LINE_LIMIT[k];
  if (codePoints(text) <= limit) return { text, cut: pre, masked: m.masked };
  const a = Array.from(text);
  return { text: a.slice(0, limit).join(''), cut: pre + a.length - limit, masked: m.masked };
}

/** the bounded ring of one session's lines */
export class TailBuffer {
  private entries: TailEntry[] = [];
  private bytes = 0;
  private nextSeq = 1;

  get last(): number { return this.nextSeq - 1; }
  get size(): number { return this.entries.length; }
  get first(): number { return this.entries[0]?.seq ?? 0; }

  add(k: TailKind, text: string, ts: number, cut = 0): TailEntry {
    const e: TailEntry = { seq: this.nextSeq++, ts, k, text, ...(cut ? { cut } : {}) };
    this.entries.push(e); this.bytes += text.length + ENTRY_OVERHEAD;
    while (this.entries.length > TAIL_MAX_ENTRIES || this.bytes > TAIL_MAX_BYTES) { const old = this.entries.shift(); if (!old) break; this.bytes -= old.text.length + ENTRY_OVERHEAD; }
    return e;
  }

  /** drops every line of a kind (tool output when the owner turns it off) */
  purge(k: TailKind): number {
    const keep = this.entries.filter((e) => e.k !== k);
    const n = this.entries.length - keep.length;
    this.entries = keep; this.bytes = keep.reduce((a, e) => a + e.text.length + ENTRY_OVERHEAD, 0);
    return n;
  }

  /** the newest lines (oldest first) that fit `maxBytes` of JSON and `maxEntries` */
  window(maxBytes: number, maxEntries = 200): TailEntry[] {
    const out: TailEntry[] = [];
    let used = 0;
    for (let i = this.entries.length - 1; i >= 0 && out.length < maxEntries; i--) {
      const e = this.entries[i]!;
      const sz = jsonBytes(e);
      if (used + sz > maxBytes) break;
      used += sz; out.push(e);
    }
    return out.reverse();
  }

  /** up to `limit` lines with `seq < before` (the newest ones if `before` is absent), oldest first; `more`: there are older lines still */
  page(before: number | undefined, limit: number, maxBytes: number): { entries: TailEntry[]; more: boolean } {
    const pool = before === undefined ? this.entries : this.entries.filter((e) => e.seq < before);
    const out: TailEntry[] = [];
    let used = 0;
    for (let i = pool.length - 1; i >= 0 && out.length < limit; i--) {
      const e = pool[i]!;
      const sz = jsonBytes(e);
      if (used + sz > maxBytes) break;
      used += sz; out.push(e);
    }
    out.reverse();
    const oldest = out[0]?.seq ?? (pool[pool.length - 1]?.seq ?? 0) + 1;
    return { entries: out, more: this.entries.some((e) => e.seq < oldest) };
  }
}

const enc = new TextEncoder();
const jsonBytes = (e: TailEntry): number => enc.encode(JSON.stringify(e)).length + 1;
