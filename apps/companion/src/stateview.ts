/**
 * Which form of the state a device gets, and fitting it into one frame. Pure functions (no I/O), so the limits are testable. Licence: Apache-2.0.
 *
 *   legacy  every client up to 0.1.2: texts of at most 300 / 1200 / 600 characters, the whole state in one 8 KB bucket. A request whose preview or
 *           summary had to be shortened for this form CANNOT be approved on such a phone (an approval must apply to what the person saw).
 *   long    a client that sent the capability `long1` (0.1.3): texts of up to 24,000 characters, the whole state in at most 64 KB (the largest bucket the
 *           relay will carry). When it does not all fit, the texts share the room by weight (the waiting request first), each text is cut at the END and
 *           says how much was cut. A request whose preview was cut cannot be approved from the phone.
 */
import type { SessionState, StateData } from './protocol/index.ts';
import { MAX_PREVIEW_CHARS, MAX_RECENT_CHARS, MAX_SUMMARY_CHARS } from './protocol/messages.ts';
import { clip } from './mask.ts';

export const LEGACY_STATE_BYTES = 7500;
/** the long form stays this far under the inner limit (JSON escaping is measured exactly; this is only a margin) */
export const STATE_MARGIN_BYTES = 256;

const enc = new TextEncoder();
const bytes = (s: string): number => enc.encode(s).length;
export const stateBytes = (s: StateData): number => bytes(JSON.stringify(s));
/** bytes a string takes inside JSON (quotes excluded) */
const escBytes = (s: string): number => bytes(JSON.stringify(s)) - 2;

/** the longest start of `s`, in whole characters (never half a surrogate pair), whose JSON form takes at most `max` bytes */
export function fitText(s: string, max: number): { text: string; cut: number } {
  if (escBytes(s) <= max) return { text: s, cut: 0 };
  const chars = Array.from(s);
  let lo = 0; let hi = chars.length;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (escBytes(chars.slice(0, mid).join('')) <= max) lo = mid; else hi = mid - 1; }
  return { text: chars.slice(0, lo).join(''), cut: chars.length - lo };
}

type Slot = { get: () => string; set: (t: string, cut: number) => void; weight: number };

function slots(st: StateData): Slot[] {
  const out: Slot[] = [];
  for (const s of st.sessions) {
    if (s.pending) {
      const p = s.pending;
      out.push({ weight: 4, get: () => p.preview, set: (t, c) => { p.preview = t; if (c) p.cut = (p.cut ?? 0) + c; } });
      out.push({ weight: 2, get: () => p.summary, set: (t) => { p.summary = t; } });
    }
    s.recent.forEach((r, i) => out.push({ weight: i === s.recent.length - 1 ? 2 : 1, get: () => r.text, set: (t, c) => { r.text = t; if (c) r.cut = (r.cut ?? 0) + c; } }));
  }
  return out;
}

/**
 * The long form, fitted to `maxBytes` of JSON. Works on a copy. Water-filling: every text gets room in proportion to its weight; a text that needs less
 * than its share leaves the rest to the others. A pending request that lost any of its preview or summary loses `can.approve`.
 */
export function fitLong(state: StateData, maxBytes: number): StateData {
  const st = structuredClone(state);
  let budget = maxBytes - STATE_MARGIN_BYTES;
  for (let attempt = 0; attempt < 6; attempt++) {
    const work = structuredClone(st);
    const all = slots(work);
    const texts = all.map((x) => x.get());
    all.forEach((x) => x.set('', 0));
    const fixed = stateBytes(work);
    let room = budget - fixed;
    if (room < 0) room = 0;
    const need = texts.map((t) => escBytes(t));
    if (need.reduce((a, b) => a + b, 0) <= room) { // everything fits: nothing is cut
      all.forEach((x, i) => x.set(texts[i]!, 0));
      return finish(work, st);
    }
    const order = all.map((_, i) => i).sort((a, b) => need[a]! / all[a]!.weight - need[b]! / all[b]!.weight);
    let weightLeft = all.reduce((a, x) => a + x.weight, 0);
    const given = new Array<number>(all.length).fill(0);
    for (const i of order) {
      const share = Math.floor((room * all[i]!.weight) / weightLeft);
      given[i] = Math.min(need[i]!, share);
      room -= given[i]!; weightLeft -= all[i]!.weight;
    }
    all.forEach((x, i) => { const r = fitText(texts[i]!, given[i]!); x.set(r.text, r.cut); });
    if (stateBytes(work) <= maxBytes) return finish(work, st);
    budget -= Math.ceil((stateBytes(work) - maxBytes) * 1.2) + 64; // measured too big (escaping in the labels etc.): give less and again
  }
  // cannot happen with real data; the shortest honest form
  const last = structuredClone(st);
  for (const s of last.sessions) { s.recent = []; if (s.pending) { const c = s.pending.preview.length; s.pending.preview = ''; s.pending.cut = (s.pending.cut ?? 0) + c; } }
  return finish(last, st);

  function finish(res: StateData, orig: StateData): StateData {
    res.sessions.forEach((s, i) => {
      const before = orig.sessions[i]!.pending;
      if (s.pending && before && ((s.pending.cut ?? 0) > (before.cut ?? 0) || s.pending.summary !== before.summary)) s.pending.can = { ...s.pending.can, approve: false };
    });
    return res;
  }
}

/** the form for a client that knows nothing of long messages (everything an old page can parse and show) */
export function toLegacy(state: StateData): StateData {
  const st = structuredClone(state);
  const lim = (s: string, max: number): { text: string; cut: boolean } => { const t = clip(s, max); return { text: t, cut: t !== s }; };
  for (const s of st.sessions) {
    if (s.pending) {
      const p = s.pending;
      const sum = lim(p.summary, MAX_SUMMARY_CHARS); const prev = lim(p.preview, MAX_PREVIEW_CHARS);
      if (sum.cut || prev.cut || p.cut) p.can = { ...p.can, approve: false }; // shown shortened: it cannot be approved from here
      p.summary = sum.text; p.preview = prev.text; delete p.cut;
    }
    s.recent = s.recent.map((r) => ({ role: r.role, ts: r.ts, text: clip(r.text, MAX_RECENT_CHARS) })) as SessionState['recent'];
  }
  // stay inside one 8 KB bucket: drop the oldest context first, then whole sessions
  let out = st;
  if (stateBytes(out) > LEGACY_STATE_BYTES) out = { ...out, sessions: out.sessions.map((s) => ({ ...s, recent: s.recent.slice(-1) })) };
  while (stateBytes(out) > LEGACY_STATE_BYTES && out.sessions.length > 1) out = { ...out, sessions: out.sessions.slice(0, -1) };
  if (stateBytes(out) > LEGACY_STATE_BYTES) { // one session whose text alone is too much (escaping): the shortest form
    out = { ...out, sessions: out.sessions.map((s) => ({ ...s, recent: [], ...(s.pending ? { pending: { ...s.pending, preview: clip(s.pending.preview, 600), can: { ...s.pending.can, approve: false } } } : {}) })) };
  }
  return out;
}
