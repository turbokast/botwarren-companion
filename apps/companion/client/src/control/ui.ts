/**
 * The remote-control screens (design: "Remote control" board, Botwarren Claude Design project): session list (machine > agent > session), live tail,
 * composer, Stop, step-up sheet, start-a-session, audit trail, and the offline / stale / kill-switch states.
 *
 * Hostile text: everything an agent wrote is put in the page with textContent only (the `h` helper makes text nodes). No markdown, no links, no images:
 * a link-shaped string is shown as text with a note and a Copy button; text that claims to come from the person or the system is labelled. Every
 * disabled control says why. Nothing here keeps a command for later: an offline computer fails the send and the draft stays in the box.
 */
import { cleanText } from '../../../src/textclean.ts';
import { ago, h } from '../ui.ts';
import { MAX_PROMPT_CHARS, type AuditEvent, type CSession, type ControlApi, type ControlHost, type LaunchEntry, type NoPrompt, type SendOutcome, type StartOptions, type StepUpAction, type StopStage, type Tail, type TailLine } from './types.ts';

export const HARNESS_NAME: Record<string, string> = {
  'claude-code': 'Claude Code', codex: 'Codex', muse: 'Muse', opencode: 'OpenCode', agy: 'Antigravity', herdr: 'Herdr', ninox: 'Ninox', copilot: 'Copilot', other: 'Another agent',
};
export const harnessName = (id: string): string => HARNESS_NAME[id] ?? 'Another agent';

type Tone = 'good' | 'warn' | 'bad' | 'info';
interface Note { tone: Tone; text: string }

const NO_PROMPT: Record<NoPrompt, (d: string, who: string) => { title: string; body: string; tone: Tone }> = {
  harness: (_d, who) => ({ title: `${who} cannot take messages from outside.`, body: `It runs in your terminal. Botwarren can approve or deny its requests, not type to it. Start a Botwarren session to message it.`, tone: 'warn' }),
  scope: (d) => ({ title: 'This phone can look, not send.', body: `To let it send messages, run: botwarren-companion devices grant ${d} control (on your computer).`, tone: 'info' }),
  bypass: () => ({ title: 'Messages are off for this session.', body: 'It runs without approval prompts, so anything you send would run unchecked. To allow it, turn on control.allowBypass on your computer.', tone: 'warn' }),
  off: () => ({ title: 'Control is switched off on your computer.', body: 'You can still read and approve. Turn it on there with: botwarren-companion control on', tone: 'bad' }),
  readonly: () => ({ title: 'Control is read only on your computer.', body: 'No messages, no stop and no start until you change it there.', tone: 'warn' }),
  ended: () => ({ title: 'This session has ended.', body: 'Nothing more can be sent to it.', tone: 'info' }),
  host_old: () => ({ title: 'Your computer\'s Companion is too old for messages.', body: 'Update it on your computer, restart it, then reload this page.', tone: 'warn' }),
  paused: () => ({ title: 'Remote answers are paused on your computer.', body: 'Nothing can be sent from here until you un-pause it there.', tone: 'bad' }),
};

const SEND_NOTE: Record<SendOutcome, Note> = {
  sent: { tone: 'info', text: 'Sent. It reached the agent, but the agent has not confirmed yet, so this is not called done. The tail updates when it moves on.' },
  applied: { tone: 'good', text: 'Sent. The agent has started on it.' },
  started: { tone: 'good', text: 'Started. The new session appears in your list.' },
  stale: { tone: 'warn', text: 'This changed while you were typing (the agent asked something new or moved on), so your message was not sent. Read what it says now, then send again. Your text is kept in the box.' },
  scope: { tone: 'warn', text: 'This phone is not allowed to send messages. On your computer: botwarren-companion devices grant <name> control. Your text is kept in the box.' },
  bypass: { tone: 'warn', text: 'That session runs without approval prompts, so your computer refused the message.' },
  harness: { tone: 'warn', text: 'That agent cannot take a message from outside. Your computer refused it.' },
  too_long: { tone: 'warn', text: `A message can be at most ${MAX_PROMPT_CHARS.toLocaleString('en')} characters. Shorten it and send again.` },
  rate_limited: { tone: 'warn', text: 'Too many messages in a short time. Wait a few minutes. Your text is kept in the box.' },
  paused: { tone: 'bad', text: 'Remote answers are paused on your computer. Your text is kept in the box.' },
  control_off: { tone: 'bad', text: 'Control is switched off on your computer. Your text is kept in the box.' },
  readonly: { tone: 'warn', text: 'Control is read only on your computer. Your text is kept in the box.' },
  offline: { tone: 'bad', text: 'Your message was not sent. The computer is offline. Commands expire after 60 seconds and are never held back. Your text is kept in the box.' },
  expired: { tone: 'bad', text: 'Expired before your computer got it. Nothing was sent. Your text is kept in the box.' },
  needs_local: { tone: 'warn', text: 'Waiting for you on your computer. It shows your message and asks you to confirm it there.' },
  stepup: { tone: 'warn', text: 'Your computer wants a fresh fingerprint or face check first. Tap Send again and confirm.' },
  failed: { tone: 'bad', text: 'Your agent can no longer be reached. Your text is kept in the box.' },
  timeout: { tone: 'warn', text: 'No answer from your computer yet. It may be offline. Your text is kept in the box.' },
  unsupported: { tone: 'warn', text: 'Your computer\'s Companion cannot do that yet. Update it, then reload this page.' },
  keystroke_prefix: { tone: 'warn', text: 'That agent takes your message typed into its terminal, so a message that starts with ! or / is refused (it would run as a command). Reword it. Your text is kept in the box.' },
  gone: { tone: 'warn', text: 'That session is gone. Nothing was sent.' },
  project: { tone: 'warn', text: 'Your computer does not allow remote control for that project. Change it on your computer.' },
  busy: { tone: 'warn', text: 'The agent cannot take a message right now. Try again in a moment. Your text is kept in the box.' },
  declined: { tone: 'warn', text: 'You declined it on your computer, so nothing was sent. Your text is kept in the box.' },
  mode_not_allowed: { tone: 'warn', text: 'Your computer does not allow that permission mode for this entry. Choose another.' },
};

const STOP_NOTE: Record<StopStage, Note> = {
  stopping: { tone: 'warn', text: 'Stopping. Waiting for the next tool call. This can take a minute while it is writing.' },
  stopped: { tone: 'good', text: 'Stopped. It stopped before its next step. Nothing further ran.' },
  stopped_now: { tone: 'good', text: 'Stopped now.' },
  unconfirmed: { tone: 'warn', text: 'Stop was sent, but the agent has not stopped yet. It may be in the middle of writing. Check the terminal.' },
  failed: { tone: 'bad', text: 'Could not stop it. Your computer could not reach the session. Stop it at the terminal.' },
  offline: { tone: 'bad', text: 'Could not stop it. The computer is offline. Stop it at the terminal.' },
  unsupported: { tone: 'warn', text: 'Your computer\'s Companion cannot stop sessions from here. Update it, or stop it at the terminal.' },
};

/** words for a send that did not reach the agent but should leave the draft alone */
const KEEP_DRAFT = new Set<SendOutcome>(['keystroke_prefix', 'busy', 'declined', 'stale', 'scope', 'bypass', 'harness', 'too_long', 'rate_limited', 'paused', 'control_off', 'readonly', 'offline', 'expired', 'stepup', 'failed', 'timeout', 'unsupported']);

const URL_RE = /\b(?:https?|ftp|file|javascript|data):[^\s]*|\bwww\.[^\s]+/i;
const SPOOF_RE = /^\s*(?:system|assistant|user|owner|human|admin(?:istrator)?|botwarren|developer)\s*[:>\]]/im;
const MARKUP_RE = /<\s*\/?\s*(?:script|img|iframe|svg|a|style|object|embed|form|input|link|meta|body|html)\b|\bon[a-z]+\s*=|\]\(/i;

const hhmm = (ts: number): string => new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const count = (s: string): number => [...s].length;

export interface DetailOptions { render: () => void; onDone: (n: Note) => void }

interface Composer { el: HTMLElement; ta: HTMLTextAreaElement; update: (s: CSession, why: NoPrompt | null) => void; asAnswer: boolean }
type Sheet = { kind: 'stepup'; action: StepUpAction; note: Note | null; busy: boolean; resolve: (r: 'ok' | 'cancelled' | 'unsupported') => void };
interface StartDraft { project: string; launchId: string; model: string; effort: string; mode: string; text: string }

export class ControlUi {
  private composers = new Map<string, Composer>();
  private sendNote = new Map<string, Note>();
  private stopNote = new Map<string, Note>();
  private busy = new Set<string>();
  private watching = new Map<string, () => void>();
  private tailMem = new Map<string, { top: number; pinned: boolean }>();
  private sheet: Sheet | null = null;
  private sheetFocus = false;
  audit: { state: 'idle' | 'loading' | 'ready' | 'error'; events: AuditEvent[] } = { state: 'idle', events: [] };
  startDraft: StartDraft = { project: '', launchId: '', model: '', effort: '', mode: '', text: '' };
  startNote: Note | null = null;
  startBusy = false;
  private revealHelp = false;

  readonly api: ControlApi;
  private readonly render: () => void;

  constructor(api: ControlApi, render: () => void) {
    this.api = api; this.render = render;
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && this.sheet && !this.sheet.busy) { e.preventDefault(); this.closeSheet('cancelled'); } });
  }

  // ------------------------------------------------------------------ helpers
  private host(): ControlHost { return this.api.host(); }

  private whyNot(s: CSession): NoPrompt | null {
    const ho = this.host();
    if (!ho.supported) return 'host_old';
    if (s.status === 'ended') return 'ended';
    if (ho.paused) return 'paused';
    if (ho.control === 'off') return 'off';
    if (ho.control === 'readonly') return 'readonly';
    if (ho.scope !== 'control') return 'scope';
    if (!s.prompt.ok) return s.prompt.why ?? 'harness';
    return null;
  }

  private stopOffered(s: CSession): boolean {
    const ho = this.host();
    return ho.supported && s.stop !== 'none' && s.status !== 'ended' && ho.control === 'on';
  }

  private pips(n: number | undefined): HTMLElement | null {
    if (!n) return null;
    const k = Math.max(1, Math.min(5, Math.round(n)));
    return h('span', { class: 'pips', role: 'img', 'aria-label': `effort ${k} of 5`, title: `effort ${k} of 5` }, ...[1, 2, 3, 4, 5].map((i) => h('i', { class: i <= k ? 'on' : '' })));
  }

  private modelChip(s: CSession): HTMLElement | null {
    if (!s.model) return null;
    return h('span', { class: 'chip dim', 'data-testid': 'model-chip' }, s.model, this.pips(s.effort));
  }

  statusChipFor(s: CSession): HTMLElement { return this.statusChip(s); }

  private statusChip(s: CSession): HTMLElement {
    const t = s.status === 'needs_you' ? ['chip', 'Needs you'] : s.status === 'working' ? ['chip ok', 'Working'] : s.status === 'ended' ? ['chip dim', 'Ended'] : ['chip dim', 'Idle'];
    return h('span', { class: t[0] ?? 'chip', 'data-testid': 'status-chip' }, t[1]);
  }

  /** what this device may do with the session, in one badge (plus the bypass warning) */
  private capBadges(s: CSession): HTMLElement[] {
    const out: HTMLElement[] = [];
    const ho = this.host();
    if (s.mode === 'bypass') out.push(h('span', { class: 'cap bp', 'data-testid': 'bypass-tag' }, 'No approval prompts'));
    if (s.status === 'ended') return out;
    if (ho.scope === 'observe') out.push(h('span', { class: 'cap obs', 'data-testid': 'cap' }, 'Observe only'));
    else if (s.mode === 'bypass') out.push(h('span', { class: 'cap obs', 'data-testid': 'cap' }, 'Observe only'));
    else if (this.whyNot(s) === null) out.push(h('span', { class: 'cap full', 'data-testid': 'cap' }, 'Full control'));
    else out.push(h('span', { class: 'cap ans', 'data-testid': 'cap' }, 'Approve only'));
    return out;
  }

  /** harness, model and effort, what this device may do, and how a message gets there: the header of an open session */
  sessionChips(s: CSession): HTMLElement {
    return h('div', { class: 'col g6', 'data-testid': 'session-head' },
      h('div', { class: 'row wrap g6' }, h('span', { class: 'chip dim' }, harnessName(s.harness)), this.modelChip(s), ...this.capBadges(s)),
      s.route ? h('p', { class: 'fine', 'data-testid': 'route' }, `Messages go in ${s.route}.`) : null);
  }

  canFreeText(s: CSession): boolean { return this.whyNot(s) === null; }

  // ------------------------------------------------------------------ banners
  banners(): HTMLElement[] {
    const ho = this.host();
    const out: HTMLElement[] = [];
    if (ho.online === false && ho.conn === 'online') out.push(h('div', { class: 'banner bad', role: 'status', 'data-testid': 'banner-offline' }, h('span', {}, '●'), h('span', {}, ho.offlineSince ? `Computer offline since ${hhmm(ho.offlineSince)}. Nothing you tap will run later.` : 'Computer offline. Nothing you tap will run later.')));
    if (ho.supported && ho.control === 'off') out.push(h('div', { class: 'banner kill', role: 'status', 'data-testid': 'banner-control-off' }, h('span', {}, '■'), h('span', {}, 'Control switched off on your computer. You can still see sessions and approve.')));
    if (ho.supported && ho.control === 'readonly') out.push(h('div', { class: 'banner warn', role: 'status', 'data-testid': 'banner-readonly' }, h('span', {}, '■'), h('span', {}, 'Control is read only on your computer: no messages, no stop, no start.')));
    return out;
  }

  /** the little status next to the title: "Control" when this device may send, nothing when it may not */
  controlChip(): HTMLElement | null {
    const ho = this.host();
    if (!ho.supported) return null;
    if (ho.control === 'off') return h('span', { class: 'chip bad', 'data-testid': 'control-chip' }, 'Control off');
    if (ho.control === 'readonly') return h('span', { class: 'chip', 'data-testid': 'control-chip' }, 'Read only');
    if (ho.scope === 'control') return h('span', { class: 'chip ok', 'data-testid': 'control-chip' }, 'Control');
    return null;
  }

  // ------------------------------------------------------------------ list
  private order(list: CSession[]): CSession[] {
    const rank = (s: CSession): number => (s.status === 'needs_you' ? 0 : s.status === 'working' ? 1 : s.status === 'idle' ? 2 : 3);
    return [...list].sort((a, b) => rank(a) - rank(b) || b.since - a.since);
  }

  private row(s: CSession, selected: boolean, open: (sid: string) => void): HTMLElement {
    const p = s.state.pending;
    const what = !p ? (s.status === 'working' ? 'working' : s.state.status) : p.kind === 'permission' ? (p.tool ? 'asks permission' : 'waiting for you') : p.kind === 'question' ? 'asks a question' : 'waiting for your next instruction';
    const readOnly = !!p && !p.can.approve && !p.can.reply && !p.can.deny;
    const note = readOnly && s.mode !== 'bypass' ? ' · answer on your computer' : '';
    const cls = `srow${s.status === 'needs_you' ? ' need' : s.status === 'working' ? ' work' : s.status === 'ended' ? ' gone' : ''}${selected ? ' sel' : ''}`;
    return h('button', { class: cls, 'data-testid': p ? 'waiting-row' : 'row', 'data-sid': s.sid, 'aria-current': selected ? 'true' : undefined, onclick: () => open(s.sid) },
      h('span', { class: 'dot', 'aria-hidden': 'true' }),
      h('span', { class: 'grow' }, h('b', {}, s.label), h('span', { class: 'sub' }, `${harnessName(s.harness)} · ${what} · ${ago(s.since)}${note}`),
        h('span', { class: 'row wrap g6 chips' }, this.statusChip(s), this.modelChip(s), ...this.capBadges(s))),
      p ? h('span', { class: 'chev', 'aria-hidden': 'true' }, '›') : null);
  }

  connPill(): HTMLElement {
    const ho = this.host();
    if (ho.conn !== 'online') return h('span', { class: 'pill off', 'data-testid': 'conn' }, ho.conn === 'killed' ? 'Switched off' : 'Connecting');
    if (ho.online === false) return h('span', { class: 'pill off', 'data-testid': 'conn' }, 'Computer offline');
    return h('span', { class: 'pill live', 'data-testid': 'conn' }, 'Computer online');
  }

  sessionList(selected: string | null, open: (sid: string) => void): HTMLElement[] {
    const ho = this.host();
    const all = this.api.sessions();
    const waiting = all.filter((s) => s.status === 'needs_you').length;
    const out: HTMLElement[] = [h('div', { class: 'mach', 'data-testid': 'machine' }, h('span', { class: `dot${ho.online === false || ho.conn !== 'online' ? ' off' : ''}`, 'aria-hidden': 'true' }), h('b', {}, ho.ready ? ho.name : 'Your computer'), h('span', { class: 'spacer' }), this.connPill())];
    if (ho.online === false && ho.offlineSince) out.push(h('p', { class: 'fine' }, `Last seen ${ago(ho.offlineSince)} ago. What is shown may be out of date.`));
    if (waiting === 0) out.push(h('p', { class: 'fine', 'data-testid': 'none-waiting' }, ho.ready ? 'Nothing is waiting for you.' : 'Waiting for your computer.'));
    else out.push(h('p', { class: 'h3', 'data-testid': 'waiting-count' }, `Waiting for you · ${waiting}`));
    const groups = new Map<string, CSession[]>();
    for (const s of this.order(all)) { const g = groups.get(s.harness); if (g) g.push(s); else groups.set(s.harness, [s]); }
    for (const [harness, list] of groups) {
      out.push(h('div', { class: 'harn', 'data-testid': 'harness' }, h('span', { class: 'gl', 'aria-hidden': 'true' }, harnessName(harness).slice(0, 1)), harnessName(harness)));
      for (const s of list) out.push(this.row(s, s.sid === selected, open));
    }
    if (ho.ready && all.length === 0) out.push(h('div', { class: 'callout', 'data-testid': 'no-sessions' }, 'No agent sessions are running on your computer right now.'));
    return out;
  }

  // ------------------------------------------------------------------ tail
  syncWatch(sid: string | null): void {
    for (const [k, off] of [...this.watching]) if (k !== sid) { off(); this.watching.delete(k); }
    if (sid && !this.watching.has(sid)) this.watching.set(sid, this.api.watch(sid));
  }

  private lineNode(l: TailLine): HTMLElement {
    const text = cleanText(l.text);
    if (l.kind === 'tool') return h('div', { class: 'ln t', 'data-testid': 'tail-line' }, text);
    if (l.kind === 'note') return h('div', { class: 'ln t note', 'data-testid': 'tail-line' }, h('span', { class: 'inertnote dimnote' }, 'Botwarren'), text);
    const notes: string[] = [];
    if (MARKUP_RE.test(text)) notes.push('Text from the agent · shown as plain text');
    const link = URL_RE.test(text);
    if (link) notes.push('Looks like a link · not clickable');
    if (l.kind !== 'user' && SPOOF_RE.test(text)) notes.push('Claims to be from you or the system · it is not');
    const base = l.kind === 'user' ? 'ln u' : l.kind === 'output' ? 'ln t out' : 'ln a';
    const kids: (Node | string | null)[] = notes.map((n) => h('span', { class: 'inertnote' }, n));
    kids.push(text);
    if (link) kids.push(h('div', { class: 'row g6' }, h('button', { class: 'ghost small', 'data-testid': 'tail-copy', onclick: (e: Event) => { const b = e.currentTarget as HTMLElement; const done = (t: string): void => { b.textContent = t; setTimeout(() => { b.textContent = 'Copy'; }, 1500); }; try { void navigator.clipboard.writeText(text).then(() => done('Copied'), () => done('Not copied')); } catch { done('Not copied'); } } }, 'Copy')));
    const el = h('div', { class: `${base}${notes.length ? ' inert' : ''}`, 'data-testid': 'tail-line', ...(l.kind === 'user' ? { 'data-from': l.from ?? '' } : {}) }, ...kids);
    return el;
  }

  tailBox(s: CSession): HTMLElement {
    const t: Tail | null = this.api.tail(s.sid);
    const ho = this.host();
    const stale = !!t && (ho.online === false || (s.status === 'working' && Date.now() - t.updatedAt > 40_000));
    const live = ho.online === false ? h('span', { class: 'live stale', 'data-testid': 'tail-live' }, h('i', {}), 'OFFLINE')
      : stale ? h('span', { class: 'live stale', 'data-testid': 'tail-live' }, h('i', {}), 'STALE')
        : s.status === 'working' || s.status === 'needs_you' ? h('span', { class: 'live', 'data-testid': 'tail-live' }, h('i', {}), 'LIVE') : h('span', { class: 'live stale', 'data-testid': 'tail-live' }, h('i', {}), s.status === 'ended' ? 'ENDED' : 'IDLE');
    const outputOn = !!t?.outputShown;
    const lines = t?.lines ?? [];
    const lastTool = (() => { for (let i = lines.length - 1; i >= 0; i--) if (lines[i]?.kind === 'tool') return i; return -1; })();
    const kids: HTMLElement[] = [];
    lines.forEach((l, i) => {
      if (l.kind === 'output' && !outputOn) return;
      kids.push(this.lineNode(l));
      if (i === lastTool && !outputOn) kids.push(h('div', { class: 'ln hid', 'data-testid': 'tail-hidden' }, h('span', {}, '▸ Tool output hidden'), h('span', { class: 'spacer' }), h('button', { class: 'link', 'data-testid': 'tail-reveal', onclick: () => { if (t?.revealOnComputer) { this.revealHelp = !this.revealHelp; } else this.api.setOutput(s.sid, true); this.render(); } }, t?.revealOnComputer ? 'How to show it' : 'Show for this session')));
      if (i === lastTool && !outputOn && t?.revealOnComputer && this.revealHelp) kids.push(h('div', { class: 'callout', 'data-testid': 'tail-reveal-help' }, 'Tool output is switched on at your computer, never from here, because it is where secrets live. On your computer run: ', h('span', { class: 'mono' }, 'botwarren-companion tools <session> on')));
    });
    if (!t) kids.push(h('div', { class: 'ln hid', 'data-testid': 'tail-wait' }, ho.online === false ? 'Waiting for your computer to come back.' : 'Waiting for the first lines from your computer.'));
    else if (lines.length === 0) kids.push(h('div', { class: 'ln hid', 'data-testid': 'tail-empty' }, 'Nothing yet.'));
    const body = h('div', { class: 'tail-b', tabindex: 0, role: 'log', 'aria-label': `Live tail of ${s.label}, scrollable`, 'aria-live': 'off', 'data-testid': 'tail-body' }, ...kids);
    const mem = this.tailMem.get(s.sid) ?? { top: 0, pinned: true };
    this.tailMem.set(s.sid, mem);
    body.addEventListener('scroll', () => { mem.top = body.scrollTop; mem.pinned = body.scrollTop + body.clientHeight >= body.scrollHeight - 24; }, { passive: true });
    requestAnimationFrame(() => { body.scrollTop = mem.pinned ? body.scrollHeight : mem.top; });
    const foot: HTMLElement[] = [h('div', { class: 'tail-f' }, h('span', {}, 'Plain text only · the agent\'s words, not Botwarren\'s'), t ? h('span', {}, `updated ${ago(t.updatedAt)}${ago(t.updatedAt) === 'now' ? '' : ' ago'}`) : null)];
    if (t?.cut) foot.unshift(h('div', { class: 'tail-f cut', 'data-testid': 'tail-cut' }, `Your computer cut ${t.cut.toLocaleString('en')} characters. Read the rest at the terminal.`));
    const head = h('div', { class: 'tail-h' }, h('span', { class: 't' }, 'Live tail'), outputOn ? h('span', { class: 'chip bad', 'data-testid': 'tail-output-chip' }, 'Output shown') : null, live);
    const box = h('div', { class: 'tail', 'data-testid': 'tail' }, head, body, ...foot);
    const extra: HTMLElement[] = [box];
    if (stale && t && ho.online !== false) extra.push(h('div', { class: 'callout warn', 'data-testid': 'tail-stale', role: 'status' }, h('b', {}, 'Tail is stale. '), `No update for ${Math.round((Date.now() - t.updatedAt) / 1000)} seconds.`));
    if (outputOn) extra.push(h('div', { class: 'callout warn', 'data-testid': 'tail-output-warn' }, h('b', {}, 'Tool output can hold secrets. '), 'Shown for this session only, until you hide it or leave. Known token shapes are masked on your computer first.'), h('button', { class: 'ghost full', 'data-testid': 'tail-hide', onclick: () => { this.api.setOutput(s.sid, false); this.render(); } }, 'Hide tool output'));
    return h('div', { class: 'col tailwrap' }, ...extra);
  }

  // ------------------------------------------------------------------ composer
  private composer(s: CSession, asAnswer: boolean): Composer {
    const key = `${s.sid}:${asAnswer ? 'a' : 'p'}`;
    const have = this.composers.get(key);
    if (have) return have;
    const ta = h('textarea', { class: 'ta', rows: 2, 'data-testid': 'compose-input', autocomplete: 'off', autocapitalize: 'sentences', spellcheck: 'true', enterkeyhint: 'enter', 'aria-describedby': `cnt-${key}` }) as HTMLTextAreaElement;
    const cnt = h('span', { class: 'count', id: `cnt-${key}`, 'data-testid': 'compose-count' }, `0 / ${MAX_PROMPT_CHARS}`);
    const queue = h('button', { class: 'ghost', 'data-testid': 'compose-queue', type: 'button' }, 'Queue') as HTMLButtonElement;
    const send = h('button', { class: 'cta small', 'data-testid': 'compose-send', type: 'button' }, asAnswer ? 'Send answer' : 'Send') as HTMLButtonElement;
    const hint = h('span', { class: 'fine hint' }, 'Send ', h('span', { class: 'kbd' }, 'Ctrl'), ' ', h('span', { class: 'kbd' }, 'Enter'));
    const el = h('div', { class: 'comp', 'data-testid': 'compose' }, ta, h('div', { class: 'bar' }, cnt, h('span', { class: 'spacer' }), hint, queue, send));
    let cur = s; let off: NoPrompt | null = null;
    const c: Composer = { el, ta, asAnswer, update: (ns, why) => { cur = ns; off = why; refresh(); } };
    const refresh = (): void => {
      const n = count(ta.value);
      cnt.textContent = `${n.toLocaleString('en')} / ${MAX_PROMPT_CHARS.toLocaleString('en')}`;
      cnt.className = `count${n > MAX_PROMPT_CHARS ? ' over' : n >= MAX_PROMPT_CHARS * 0.9 ? ' near' : ''}`;
      const blocked = off !== null;
      el.classList.toggle('off', blocked);
      ta.disabled = blocked;
      ta.placeholder = blocked ? (asAnswer ? 'Free-text answer not available' : `Message ${cur.label} is not available`) : asAnswer ? 'Type an answer' : `Message ${cur.label}`;
      ta.setAttribute('aria-label', asAnswer ? `Answer ${cur.label}` : `Message ${cur.label}`);
      const empty = ta.value.trim() === '';
      const busy = this.busy.has(cur.sid);
      send.disabled = blocked || empty || n > MAX_PROMPT_CHARS || busy;
      queue.disabled = send.disabled;
      queue.style.display = !blocked && cur.prompt.queue && !asAnswer ? '' : 'none';
      hint.style.display = blocked ? 'none' : '';
      send.textContent = busy ? 'Sending...' : asAnswer ? 'Send answer' : 'Send';
    };
    ta.addEventListener('input', () => { refresh(); });
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !send.disabled) { e.preventDefault(); void this.sendText(cur, ta, asAnswer, refresh); } });
    send.addEventListener('click', () => { void this.sendText(cur, ta, asAnswer, refresh); });
    queue.addEventListener('click', () => { void this.sendText(cur, ta, asAnswer, refresh); });
    this.composers.set(key, c);
    return c;
  }

  private async sendText(s: CSession, ta: HTMLTextAreaElement, asAnswer: boolean, refresh: () => void): Promise<void> {
    const text = ta.value.trim();
    if (text === '' || count(text) > MAX_PROMPT_CHARS || this.busy.has(s.sid)) return;
    this.sendNote.delete(s.sid);
    const target = `${harnessName(s.harness)}${s.model ? ` · ${s.model}` : ''}`;
    const gate = await this.stepUp({ kind: asAnswer ? 'answer' : 'prompt', title: asAnswer ? `Answer ${s.label}` : `Send a message to ${s.label}`, text, target, fresh: false, bind: { kind: asAnswer ? 'answer' : 'prompt', target: s.sid } });
    if (gate === 'cancelled') { this.sendNote.set(s.sid, { tone: 'info', text: 'Not sent. You did not confirm. Your text is kept in the box.' }); this.render(); return; }
    this.busy.add(s.sid); refresh(); this.render();
    let r: SendOutcome;
    try { r = await this.api.prompt(s, text, asAnswer); } catch { r = 'failed'; }
    this.busy.delete(s.sid);
    if (!KEEP_DRAFT.has(r)) ta.value = '';
    this.sendNote.set(s.sid, SEND_NOTE[r]);
    refresh(); this.render();
  }

  /** the composer or the reason it is off; `asAnswer` is the free-text answer to a question */
  composeArea(s: CSession, asAnswer = false): HTMLElement[] {
    const why = this.whyNot(s);
    const c = this.composer(s, asAnswer);
    c.update(s, why);
    const out: HTMLElement[] = [];
    if (why) {
      const t = NO_PROMPT[why](this.api.deviceName(), harnessName(s.harness));
      out.push(h('div', { class: `callout ${t.tone}`, 'data-testid': 'compose-why', 'data-why': why }, h('b', {}, `${t.title} `), t.body));
    } else out.push(h('p', { class: 'fine', 'data-testid': 'compose-route' }, `Sent as from paired device ${this.api.deviceName()}. `, this.api.stepUp.supported() ? 'Needs your fingerprint or face (unlocked for 15 minutes).' : 'Your computer asks you to confirm it there.'));
    out.push(c.el);
    const n = this.sendNote.get(s.sid);
    if (n) out.push(h('div', { class: `callout ${n.tone}`, role: 'status', 'data-testid': 'send-note' }, n.text));
    return out;
  }

  // ------------------------------------------------------------------ stop
  stopArea(s: CSession): HTMLElement[] {
    const out: HTMLElement[] = [];
    if (s.status === 'ended') return out;
    const note = this.stopNote.get(s.sid);
    if (this.stopOffered(s)) {
      const busy = note?.text === STOP_NOTE.stopping.text;
      out.push(h('button', { class: 'stop', 'data-testid': 'stop', disabled: busy, onclick: () => { void this.doStop(s); } }, 'Stop', h('small', {}, s.stop === 'soft' ? 'Stops at the next tool call' : 'Stops at once')));
      if (s.stop === 'soft' && !note) out.push(h('p', { class: 'fine' }, `${harnessName(s.harness)} finishes the step it is on. It cannot be cut while it is only writing text.`));
    } else if (this.host().supported && s.stopWhy && this.host().control === 'on') out.push(h('p', { class: 'fine', 'data-testid': 'stop-why' }, `No Stop button: ${s.stopWhy}`));
    if (note) out.push(h('div', { class: `callout ${note.tone}`, role: 'status', 'data-testid': 'stop-note' }, note.text));
    return out;
  }

  private async doStop(s: CSession): Promise<void> {
    this.stopNote.set(s.sid, STOP_NOTE.stopping); this.render();
    const fin = await this.api.stop(s, (st) => { this.stopNote.set(s.sid, STOP_NOTE[st]); this.render(); }).catch((): StopStage => 'failed');
    this.stopNote.set(s.sid, STOP_NOTE[fin]); this.render();
  }

  // ------------------------------------------------------------------ step-up
  /** resolves 'ok' (confirmed, or still inside the 15 minute window), 'unsupported' (no fingerprint or face lock: the computer asks instead) or 'cancelled' */
  stepUp(action: StepUpAction): Promise<'ok' | 'cancelled' | 'unsupported'> {
    if (!this.api.stepUp.supported()) return Promise.resolve('unsupported');
    if (!action.fresh && this.api.stepUp.unlockedUntil() > Date.now()) return Promise.resolve('ok');
    return new Promise((resolve) => { this.sheet = { kind: 'stepup', action, note: null, busy: false, resolve }; this.sheetFocus = true; this.render(); });
  }

  private closeSheet(r: 'ok' | 'cancelled' | 'unsupported'): void {
    const sh = this.sheet; this.sheet = null; sh?.resolve(r); this.render();
  }

  overlay(): HTMLElement[] {
    const sh = this.sheet;
    if (!sh) return [];
    const a = sh.action;
    const confirm = h('button', { class: 'cta cy full', 'data-testid': 'stepup-confirm', disabled: sh.busy, onclick: () => {
      sh.busy = true; sh.note = null; this.render();
      void this.api.stepUp.confirm(a).then((r) => {
        if (this.sheet !== sh) return;
        sh.busy = false;
        if (r === 'ok') this.closeSheet('ok');
        else if (r === 'unsupported') this.closeSheet('unsupported');
        else { sh.note = r === 'cancelled' ? { tone: 'warn', text: 'Not confirmed. Try again, or Cancel.' } : { tone: 'bad', text: 'Could not confirm with this device. Try again, or Cancel.' }; this.render(); }
      }, () => { sh.busy = false; sh.note = { tone: 'bad', text: 'Could not confirm with this device. Try again, or Cancel.' }; this.render(); });
    } }, sh.busy ? 'Waiting for your device...' : a.fresh ? 'Confirm with fingerprint or face' : 'Confirm with fingerprint or face');
    const kids: (HTMLElement | null)[] = [
      h('div', { class: 'grab', 'aria-hidden': 'true' }), h('p', { class: 'eyebrow warm' }, 'Confirm it is you'), h('h2', { class: 'sheet-title', id: 'stepup-title' }, a.title),
      a.text !== undefined ? h('div', { class: 'tail' }, h('div', { class: 'tail-b plain', 'data-testid': 'stepup-text' }, a.text), h('div', { class: 'tail-f' }, h('span', {}, `${count(a.text)} character${count(a.text) === 1 ? '' : 's'}`), h('span', {}, a.target ?? ''))) : a.target ? h('p', { class: 'fine' }, a.target) : null,
      confirm,
      h('p', { class: 'fine' }, a.fresh ? 'Starting a session always asks again.' : 'After you confirm, messages to your sessions are unlocked for 15 minutes on this device. Starting a session always asks again.'),
      sh.note ? h('div', { class: `callout ${sh.note.tone}`, role: 'status', 'data-testid': 'stepup-note' }, sh.note.text) : null,
      h('button', { class: 'ghost full', 'data-testid': 'stepup-cancel', disabled: sh.busy, onclick: () => this.closeSheet('cancelled') }, 'Cancel'),
    ];
    if (this.sheetFocus) { this.sheetFocus = false; requestAnimationFrame(() => { (document.querySelector('[data-testid="stepup-confirm"]') as HTMLElement | null)?.focus(); }); }
    return [h('div', { class: 'sheetbg', 'aria-hidden': 'true', onclick: () => { if (!sh.busy) this.closeSheet('cancelled'); } }), h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'stepup-title', 'data-testid': 'stepup' }, ...kids)];
  }

  // ------------------------------------------------------------------ fingerprint or face lock (Devices screen)
  private lockNote: Note | null = null;
  private lockBusy = false;
  /** the device's step-up lock: on, or an offer to add one (the computer asks its owner at the keyboard first) */
  lockCard(): HTMLElement | null {
    const su = this.api.stepUp;
    const ho = this.host();
    if (!ho.supported || ho.scope !== 'control') return null;
    const on = su.supported();
    const can = !!su.canRegister?.();
    if (!on && !can && !this.lockNote) return null;
    const body: (HTMLElement | null)[] = [
      h('div', { class: 'row between' }, h('b', {}, 'Fingerprint or face lock'), h('span', { class: on ? 'pill live' : 'pill off', 'data-testid': 'lock-state' }, on ? 'On' : 'Not set up')),
      h('p', { class: 'fine' }, on ? 'Sending a message unlocks this device for 15 minutes. Starting a session always asks again.' : 'Without it, your computer shows each message and asks you to confirm it there.'),
      can ? h('button', { class: 'cta full', 'data-testid': 'lock-add', disabled: this.lockBusy, onclick: () => { void this.addLock(); } }, this.lockBusy ? 'Waiting for your computer...' : 'Add a fingerprint or face lock') : null,
      this.lockNote ? h('div', { class: `callout ${this.lockNote.tone}`, role: 'status', 'data-testid': 'lock-note' }, this.lockNote.text) : null,
    ];
    return h('div', { class: 'card col', 'data-testid': 'lock-card' }, ...body);
  }

  private async addLock(): Promise<void> {
    this.lockBusy = true; this.lockNote = { tone: 'info', text: 'Your computer asks you at the keyboard first. Say yes there, then confirm on this device.' }; this.render();
    let r: { ok: boolean; why?: string | undefined } = { ok: false, why: 'failed' };
    try { r = (await this.api.stepUp.register?.()) ?? r; } catch { /* shown as failed */ }
    this.lockBusy = false;
    this.lockNote = r.ok ? { tone: 'good', text: 'Added. Messages from this device now ask for your fingerprint or face.' } : r.why === 'declined' ? { tone: 'warn', text: 'Not added: it was declined, here or on your computer.' } : { tone: 'bad', text: 'Could not add it. Try again.' };
    this.render();
  }

  // ------------------------------------------------------------------ audit
  async loadAudit(): Promise<void> {
    this.audit = { state: 'loading', events: [] }; this.render();
    try { this.audit = { state: 'ready', events: await this.api.audit() }; } catch { this.audit = { state: 'error', events: [] }; }
    this.render();
  }

  auditView(): HTMLElement[] {
    const a = this.audit;
    const ho = this.host();
    const WHAT: Record<AuditEvent['kind'], string> = { prompt: 'Message', interrupt: 'Stop', start: 'Start', approve: 'Approve once', deny: 'Deny', reply: 'Answer', unlock: 'Unlock · 15 min', refused: 'Refused' };
    const out: HTMLElement[] = [];
    if (!ho.supported) out.push(h('div', { class: 'callout warn', 'data-testid': 'audit-old' }, h('b', {}, 'Your computer keeps this log, and its Companion is too old to share it. '), 'Update it on your computer, then reload this page.'));
    else if (a.state === 'loading') out.push(h('p', { class: 'fine', 'data-testid': 'audit-loading' }, 'Asking your computer...'));
    else if (a.state === 'error') out.push(h('div', { class: 'callout bad', 'data-testid': 'audit-error' }, 'Your computer did not send its log. It may be offline. Try again in a moment.'));
    else if (a.events.length === 0) out.push(h('p', { class: 'fine', 'data-testid': 'audit-empty' }, 'Nothing yet. Every message, stop, start and approval from your devices will appear here.'));
    for (const e of a.events) {
      out.push(h('div', { class: 'ev', 'data-testid': 'audit-row' }, h('span', { class: 'tm' }, hhmm(e.ts)), h('span', { class: `what${e.kind === 'refused' ? ' warnc' : e.kind === 'interrupt' ? ' badc' : ''}` }, `${WHAT[e.kind]}${e.target ? ` · ${e.target}` : ''}`), h('span', { class: 'meta' }, [e.device, e.chars !== undefined ? `${e.chars} chars` : '', e.outcome, e.note ?? ''].filter((x) => x !== '').join(' · '))));
    }
    out.push(h('p', { class: 'fine pushdown' }, 'Lengths and checksums only. The text you sent is not kept here. Your computer keeps the full log.'));
    return out;
  }

  // ------------------------------------------------------------------ start
  private entriesFor(project: string): LaunchEntry[] { return this.host().launch.filter((l) => l.project === project); }

  startView(close: () => void): HTMLElement[] {
    const ho = this.host();
    const d = this.startDraft;
    const projects = [...new Set(ho.launch.map((l) => l.project))];
    const entry = ho.launch.find((l) => l.id === d.launchId) ?? null;
    const pick = (project: string): void => { const e = this.entriesFor(project)[0]; d.project = project; this.pickEntry(e); this.render(); };
    const out: HTMLElement[] = [];
    if (!ho.supported || ho.control !== 'on' || ho.scope !== 'control') {
      const why: NoPrompt = !ho.supported ? 'host_old' : ho.control === 'off' ? 'off' : ho.control === 'readonly' ? 'readonly' : 'scope';
      const t = NO_PROMPT[why](this.api.deviceName(), 'This agent');
      out.push(h('div', { class: `callout ${t.tone}`, 'data-testid': 'start-why' }, h('b', {}, `${t.title} `), t.body.replace('send messages', 'start sessions')));
      return out;
    }
    if (projects.length === 0) return [h('div', { class: 'callout warn', 'data-testid': 'start-empty' }, h('b', {}, 'Nothing is listed to start. '), 'Your computer decides what can be started from here: projects, agents and models. Add an entry on your computer first. This page never sends a path or a command.')];
    if (d.project === '' || !entry) { d.project = d.project || (projects[0] ?? ''); this.pickEntry(this.entriesFor(d.project)[0]); }
    const e2 = ho.launch.find((l) => l.id === d.launchId) ?? null;
    const chooser = (label: string, items: { id: string; label: string }[], value: string, set: (id: string) => void, tid: string): HTMLElement[] => [
      h('p', { class: 'h3' }, label),
      h('div', { class: 'row wrap g6', role: 'radiogroup', 'aria-label': label }, ...items.map((i) => h('button', { class: `ghost${i.id === value ? ' on' : ''}`, role: 'radio', 'aria-checked': String(i.id === value), 'data-testid': `${tid}-${i.id}`, onclick: () => { set(i.id); this.render(); } }, i.label))),
    ];
    out.push(h('p', { class: 'h3' }, 'Project'));
    for (const p of projects) out.push(h('button', { class: `sel2${p === d.project ? ' on' : ''}`, role: 'radio', 'aria-checked': String(p === d.project), 'data-testid': `start-project-${p}`, onclick: () => pick(p) }, h('b', {}, p), p === d.project ? h('span', { class: 'chip ok' }, 'Selected') : h('span', { class: 'fine' }, 'listed on your computer')));
    const here = this.entriesFor(d.project);
    out.push(...chooser('Agent', here.map((l) => ({ id: l.id, label: harnessName(l.harness) })), d.launchId, (id) => this.pickEntry(here.find((l) => l.id === id)), 'start-agent'));
    if (e2) {
      if (e2.models.length) out.push(...chooser('Model', e2.models, d.model, (id) => { d.model = id; }, 'start-model'));
      if (e2.efforts.length) out.push(...chooser('Effort', e2.efforts, d.effort, (id) => { d.effort = id; }, 'start-effort'));
      if (e2.modes.length) { out.push(...chooser('Permissions', e2.modes, d.mode, (id) => { d.mode = id; }, 'start-mode')); out.push(h('p', { class: 'fine' }, 'Running without approval prompts is never offered here.')); }
    }
    const ta = h('textarea', { class: 'ta', rows: 3, 'data-testid': 'start-text', placeholder: 'What should it start with?', 'aria-label': 'First message (optional)', autocomplete: 'off' }) as HTMLTextAreaElement;
    ta.value = d.text;
    const cnt = h('span', { class: 'count', 'data-testid': 'start-count' }, `${count(d.text)} / ${MAX_PROMPT_CHARS.toLocaleString('en')}`);
    ta.addEventListener('input', () => { d.text = ta.value; const n = count(d.text); cnt.textContent = `${n.toLocaleString('en')} / ${MAX_PROMPT_CHARS.toLocaleString('en')}`; cnt.className = `count${n > MAX_PROMPT_CHARS ? ' over' : n >= MAX_PROMPT_CHARS * 0.9 ? ' near' : ''}`; go.disabled = this.startBusy || n > MAX_PROMPT_CHARS; });
    out.push(h('p', { class: 'h3' }, 'First message (optional)'), h('div', { class: 'comp' }, ta, h('div', { class: 'bar' }, cnt)));
    const go = h('button', { class: 'cta full pushdown', 'data-testid': 'start-go', disabled: this.startBusy || count(d.text) > MAX_PROMPT_CHARS, onclick: () => { void this.doStart(close); } }, this.startBusy ? 'Starting...' : this.api.stepUp.supported() ? 'Start with fingerprint or face' : 'Start') as HTMLButtonElement;
    if (this.startNote) out.push(h('div', { class: `callout ${this.startNote.tone}`, role: 'status', 'data-testid': 'start-note' }, this.startNote.text));
    out.push(go);
    return out;
  }

  private pickEntry(e: LaunchEntry | undefined): void {
    const d = this.startDraft;
    d.launchId = e?.id ?? ''; d.model = e?.models[0]?.id ?? ''; d.effort = e?.efforts[0]?.id ?? ''; d.mode = e?.modes[0]?.id ?? '';
  }

  private async doStart(close: () => void): Promise<void> {
    const d = this.startDraft;
    const e = this.host().launch.find((l) => l.id === d.launchId);
    if (!e || this.startBusy || count(d.text) > MAX_PROMPT_CHARS) return;
    this.startNote = null;
    const model = e.models.find((m) => m.id === d.model)?.label;
    const gate = await this.stepUp({ kind: 'start', title: `Start ${harnessName(e.harness)} in ${e.project}`, ...(d.text.trim() ? { text: d.text.trim() } : {}), target: [harnessName(e.harness), model].filter(Boolean).join(' · '), fresh: true, bind: { kind: 'start', target: `${e.id}:${d.mode || 'default'}` } });
    if (gate === 'cancelled') { this.startNote = { tone: 'info', text: 'Not started. You did not confirm.' }; this.render(); return; }
    this.startBusy = true; this.render();
    const o: StartOptions = { project: e.project, harness: e.harness, ...(d.model ? { model: d.model } : {}), ...(d.effort ? { effort: d.effort } : {}), ...(d.mode ? { mode: d.mode } : {}), ...(d.text.trim() ? { text: d.text.trim() } : {}) };
    let r: SendOutcome;
    try { r = await this.api.start(e.id, o); } catch { r = 'failed'; }
    this.startBusy = false;
    if (r === 'started' || r === 'sent' || r === 'applied') { this.startDraft.text = ''; this.startNote = null; close(); this.render(); return; }
    this.startNote = SEND_NOTE[r]; this.render();
  }
}
