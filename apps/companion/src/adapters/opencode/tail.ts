/**
 * OpenCode v2 session messages -> live tail lines (pure; no I/O). Shapes recorded from opencode 2.0.21 (`GET /api/session/{id}/message`, see
 * test/support/fixtures/opencode-v2-shapes.json): a message is `{id, time:{created, completed?}, type:'user', text}` or
 * `{type:'assistant', content:[{type:'text', text} | {type:'reasoning', text} | {type:'tool', name, state:{status, input, content?}}], error?}`.
 *
 * What is shown: the user's text, the assistant's text, a one-line summary of each tool call (its name and ONE of command / file / pattern), and the tool's
 * output as `tool_out` (the host drops it unless the owner turned tool output on for the session). Never shown: reasoning (the model's private working),
 * system and synthetic messages, a shell message. A part that may still be streaming is held back until it is final, so the tail never shows half a line
 * and never shows the same line twice.
 * Licence: Apache-2.0.
 */
import { clip } from '../../mask.ts';
import type { TailKind } from '../types.ts';

export interface TailLine { id: string; k: TailKind; text: string; ts: number }

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
/** the one input field a one-line summary shows, in order of preference */
const SUMMARY_FIELDS = ['command', 'filePath', 'file_path', 'path', 'pattern', 'url', 'query', 'description'] as const;
const TEXT_MAX = 4000;
const OUT_MAX = 2000;

function toolSummary(name: string, input: unknown): string {
  const o = isObj(input) ? input : {};
  for (const f of SUMMARY_FIELDS) { const v = str(o[f]).replace(/\s+/g, ' ').trim(); if (v) return clip(`${name}: ${v}`, 200); }
  return clip(name || 'tool', 200);
}

function toolOutput(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((c) => (isObj(c) && c.type === 'text' ? str(c.text) : isObj(c) && c.type === 'file' ? `[file ${str(c.name) || str(c.mime)}]` : '')).filter(Boolean).join('\n');
}

/** lines for one message; each has a stable `id` so a later poll that sees the same message again emits nothing twice */
export function messageLines(m: unknown, fallbackTs: number): TailLine[] {
  if (!isObj(m)) return [];
  const mid = str(m.id); if (!mid) return [];
  const time = isObj(m.time) ? m.time : {};
  const created = num(time.created, fallbackTs);
  const done = typeof time.completed === 'number';
  const out: TailLine[] = [];
  if (m.type === 'user') {
    const text = str(m.text).trim();
    if (text) out.push({ id: `${mid}:u`, k: 'user', text: clip(text, TEXT_MAX), ts: created });
    return out;
  }
  if (m.type !== 'assistant') return out;
  const parts = Array.isArray(m.content) ? m.content : [];
  parts.forEach((p, i) => {
    if (!isObj(p)) return;
    const later = i < parts.length - 1;
    if (p.type === 'text') {
      const text = str(p.text).trim();
      if (text && (done || later)) out.push({ id: `${mid}:${i}:t`, k: 'assistant', text: clip(text, TEXT_MAX), ts: created });
    } else if (p.type === 'tool') {
      const st = isObj(p.state) ? p.state : {};
      const status = str(st.status); const name = str(p.name);
      if (status === 'running' || status === 'completed' || status === 'error') out.push({ id: `${mid}:${i}:c`, k: 'tool', text: toolSummary(name, st.input), ts: created });
      if (status === 'completed') { const o = toolOutput(st.content).trim(); if (o) out.push({ id: `${mid}:${i}:o`, k: 'tool_out', text: clip(o, OUT_MAX), ts: created }); }
      if (status === 'error') { const e = isObj(st.error) ? st.error : {}; const t = str(e.message).trim() || toolOutput(st.content).trim(); if (t) out.push({ id: `${mid}:${i}:o`, k: 'tool_out', text: clip(t, OUT_MAX), ts: created }); }
    }
  });
  if (isObj(m.error)) { const t = str(m.error.message).trim(); out.push({ id: `${mid}:e`, k: 'note', text: clip(`OpenCode reported an error${str(m.error.type) ? ` (${str(m.error.type)})` : ''}${t ? `: ${t}` : ''}`, 400), ts: num(time.completed, created) }); }
  return out;
}
