/**
 * Incremental reader of a Claude Code session transcript (`transcript_path`, JSONL) for the live tail (protocol 3, WP9). It yields plain items for
 * `ctx.report.tail`: assistant text, one-line tool-call summaries, the user's own prompts (including the ones that came through our channel) and, only when
 * the owner turned tool output on for the session, tool results. The host cleans, masks and bounds every line afterwards (tail.ts); this file never decides
 * what may leave the machine, it only extracts. The transcript format is NOT a public contract of Claude Code (docs/CLIENT_SECURITY.md
 * part 2): anything unexpected is skipped, never thrown. Only files under Claude Code's own projects folder are read (`safeTranscript`).
 * Licence: Apache-2.0.
 */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import type { TailKind } from '../protocol/index.ts';
import { safeTranscript } from '../sessions.ts';
import { clip } from '../mask.ts';

export interface TranscriptItem { k: TailKind; text: string; ts: number; uuid?: string }

/** first read looks back this far (a window of recent lines is what the tail shows); each later read takes what was appended */
const FIRST_BYTES = 64 * 1024;
const MAX_READ = 512 * 1024;
const SEEN_MAX = 400;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const oneLine = (s: string, max: number): string => clip(s.replace(/\s+/g, ' ').trim(), max);

/** a short single line for a tool call: what the tool is and the command, file or query it was given */
export function toolLine(name: string, input: Record<string, unknown>): string {
  const pick = (...keys: string[]): string => { for (const k of keys) { const v = str(input[k]); if (v) return v; } return ''; };
  const q = Array.isArray(input.questions) ? str(obj(input.questions[0]).question) : '';
  const detail = q || pick('command', 'file_path', 'path', 'url', 'query', 'pattern', 'description', 'prompt');
  return oneLine(detail ? `${name}: ${detail}` : name, 300);
}

/** the text of one transcript `message.content`: a string, or the text blocks joined */
function blockText(c: unknown): string {
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.map((b) => { const o = obj(b); return o.type === 'text' ? str(o.text) : ''; }).filter(Boolean).join('\n');
}

/** a message that arrived through a channel is stored as `<channel source="..." ...>body</channel>`: show the body and say where it came from */
export function unwrapChannel(text: string): { text: string; source?: string } {
  const m = /^\s*<channel\s+source="([^"]{1,60})"[^>]*>\n?([\s\S]*?)\n?<\/channel>\s*$/.exec(text);
  return m ? { text: m[2] ?? '', source: m[1] ?? '' } : { text };
}

/** the items one transcript line yields (none for lines that are not conversation: summaries, snapshots, system notes, side chains, meta messages) */
export function itemsOfLine(line: string, o: { toolOutput: boolean }): TranscriptItem[] {
  let j: Record<string, unknown>;
  try { j = obj(JSON.parse(line)); } catch { return []; }
  if (j.isSidechain === true || j.isMeta === true) return [];
  const type = str(j.type);
  const msg = obj(j.message);
  const role = str(msg.role) || type;
  const ts = j.timestamp ? Date.parse(str(j.timestamp)) || 0 : 0;
  const uuid = str(j.uuid) || undefined;
  const base = { ts, ...(uuid ? { uuid } : {}) };
  const out: TranscriptItem[] = [];
  const content = msg.content;
  if (role === 'assistant') {
    if (typeof content === 'string') { if (content.trim()) out.push({ k: 'assistant', text: content, ...base }); return out; }
    for (const b of Array.isArray(content) ? content : []) {
      const x = obj(b);
      if (x.type === 'text' && str(x.text).trim()) out.push({ k: 'assistant', text: str(x.text), ...base });
      else if (x.type === 'tool_use') out.push({ k: 'tool', text: toolLine(str(x.name) || 'tool', obj(x.input)), ...base });
      // `thinking` blocks are the model's own reasoning: never part of a tail
    }
    return out;
  }
  if (role === 'user') {
    if (Array.isArray(content)) {
      for (const b of content) {
        const x = obj(b);
        if (x.type === 'tool_result') { if (o.toolOutput) { const t = blockText(x.content); if (t.trim()) out.push({ k: 'tool_out', text: t, ...base }); } }
      }
    }
    const t = blockText(content);
    if (t.trim() && !/^\s*<(command-name|command-message|local-command|system-reminder|bash-input|bash-stdout|task-notification)/.test(t)) {
      const u = unwrapChannel(t);
      out.push({ k: 'user', text: u.source ? `[via ${u.source}] ${u.text}` : u.text, ...base });
    }
    return out;
  }
  return out;
}

export interface Cursor { path: string; offset: number; seen: Set<string>; size: number }

/** reads what was appended since the last call (or the last 64 KB the first time); returns the items and whether any line mentioned a needle (the caller's proof checks) */
export function readNew(cursor: Cursor | null, path: string, o: { toolOutput: boolean; env?: Record<string, string | undefined> }): { cursor: Cursor; items: TranscriptItem[]; raw: string } | null {
  const safe = safeTranscript(path, o.env ?? process.env);
  if (!safe) return null;
  let fd: number | null = null;
  try {
    fd = openSync(safe, 'r');
    const st = fstatSync(fd);
    if (!st.isFile()) return null;
    const fresh = !cursor || cursor.path !== safe || st.size < cursor.offset;
    let start = fresh ? Math.max(0, st.size - FIRST_BYTES) : cursor!.offset;
    if (st.size - start > MAX_READ) start = st.size - MAX_READ;
    const cur: Cursor = fresh ? { path: safe, offset: start, seen: new Set(), size: st.size } : cursor!;
    if (!fresh && st.size === cur.offset) return { cursor: cur, items: [], raw: '' };
    const buf = Buffer.alloc(st.size - start);
    readSync(fd, buf, 0, buf.length, start);
    // the first line of a first read may be cut: skip to the next one. An unfinished last line (no newline yet) is left for the next read.
    const begin = fresh && start > 0 ? buf.indexOf(0x0a) + 1 : 0;
    const lastNl = buf.lastIndexOf(0x0a);
    const end = lastNl >= begin ? lastNl + 1 : begin;
    const complete = buf.subarray(begin, end).toString('utf8');
    const next: Cursor = { path: safe, offset: start + end, seen: cur.seen, size: st.size };
    const items: TranscriptItem[] = [];
    for (const line of complete.split('\n')) {
      if (!line.trim()) continue;
      for (const it of itemsOfLine(line, { toolOutput: o.toolOutput })) {
        if (it.uuid) { const key = `${it.uuid}:${it.k}:${it.text.length}`; if (next.seen.has(key)) continue; next.seen.add(key); if (next.seen.size > SEEN_MAX) next.seen.delete(next.seen.values().next().value as string); }
        items.push(it);
      }
    }
    return { cursor: next, items, raw: complete };
  } catch { return null; } finally { if (fd !== null) try { closeSync(fd); } catch { /* ignore */ } }
}
