/**
 * The Botwarren Companion web client (Apache-2.0). Started by the verified loader. See docs/PROTOCOL.md.
 */
import { Link, type Outcome } from './link.ts';
import { ago, h, mount } from './ui.ts';
import type { Pending, SessionState } from '../../src/protocol/index.ts';

export interface BuildInfo { build: string; version: string; keyId: string; expires: string }

type Screen = { t: 'pair'; prefill: string; error?: string } | { t: 'sas'; sas: string; note?: string } | { t: 'home' } | { t: 'card'; sid: string } | { t: 'devices' } | { t: 'gone'; why: string };

const OUTCOME_TEXT: Record<Outcome | 'timeout' | 'offline', { tone: 'good' | 'warn' | 'bad' | 'info'; text: string }> = {
  applied: { tone: 'good', text: 'Done. Your agent is working again.' },
  denied: { tone: 'good', text: 'Denied. Nothing ran.' },
  expired: { tone: 'bad', text: 'Expired. Your agent stopped waiting. Nothing was sent.' },
  stale: { tone: 'warn', text: 'This changed. Your agent asked something new, so this card was closed. Open it again to see what it asks now.' },
  rejected: { tone: 'warn', text: 'Your computer did not accept that here. Answer at the terminal.' },
  needs_local: { tone: 'warn', text: 'Waiting for you on your computer. Your computer asks you to confirm this one there.' },
  paused: { tone: 'bad', text: 'Remote answers are paused on your computer.' },
  rate_limited: { tone: 'warn', text: 'Too many answers in a short time. Wait a minute.' },
  failed: { tone: 'bad', text: 'Your agent can no longer be reached. It may have been answered at the terminal.' },
  timeout: { tone: 'warn', text: 'No answer from your computer yet. It may be offline.' },
  offline: { tone: 'bad', text: 'Not connected. Reconnecting.' },
};

export async function start(info: BuildInfo): Promise<void> {
  const root = document.getElementById('root');
  if (!root) return;
  let link = await Link.load().catch(() => null);
  let screen: Screen = link ? { t: 'home' } : { t: 'pair', prefill: codeFromHash() };
  let notice: { tone: 'good' | 'warn' | 'bad' | 'info'; text: string } | null = null;
  let lastWaiting = 0;
  const unsupported = !globalThis.crypto?.subtle || !globalThis.indexedDB;

  const go = (s: Screen): void => { screen = s; notice = null; render(); };
  const top = (right?: HTMLElement): HTMLElement => h('div', { class: 'topbar' }, h('span', { class: 'wm' }, 'Botwarren'), h('span', { class: 'wmsub' }, 'LINK'), h('span', { class: 'spacer' }), right ?? h('span', { class: 'mini', 'data-testid': 'build' }, `build ${info.build}`));

  function codeFromHash(): string { const m = /^#\/pair\/([0-9A-Za-z-]{16,24})$/.exec(location.hash); return m?.[1] ?? ''; }

  // ------------------------------------------------------------------ screens
  function pairView(s: Extract<Screen, { t: 'pair' }>): HTMLElement[] {
    const input = h('input', { class: 'input', id: 'code', 'data-testid': 'code', type: 'text', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', inputmode: 'text', placeholder: 'XXXX-XXXX-XXXX-XXXX', 'aria-label': 'Pairing code', value: s.prefill }) as HTMLInputElement;
    const doPair = async (): Promise<void> => {
      const name = defaultName();
      try {
        const { sas, finish } = await Link.beginPair(location.origin, input.value, name);
        go({ t: 'sas', sas });
        const ok = await finish();
        if (!ok) { go({ t: 'pair', prefill: '', error: 'Pairing was declined or timed out. Start again on your computer.' }); return; }
        link = await Link.load();
        if (link) { attach(link); history.replaceState(null, '', location.pathname); go({ t: 'home' }); }
      } catch (e) { go({ t: 'pair', prefill: input.value, error: (e as Error).message }); }
    };
    input.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') void doPair(); });
    return [top(), h('div', { class: 'col page' },
      h('p', { class: 'eyebrow' }, 'Pair this phone'), h('h1', { class: 'title' }, 'Type the code from your computer'),
      h('p', { class: 'lede' }, 'Run ', h('span', { class: 'mono accent' }, 'botwarren-companion pair'), ' on the computer your agents work on. Or scan its QR code with this phone\'s camera.'),
      input,
      s.error ? h('div', { class: 'callout bad', role: 'alert', 'data-testid': 'pair-error' }, s.error) : null,
      h('p', { class: 'fine' }, `This page checked its own signature before it started (build ${info.build}).`),
      h('button', { class: 'cta full', 'data-testid': 'pair-btn', onclick: () => { void doPair(); } }, 'Pair'))];
  }

  function sasView(s: Extract<Screen, { t: 'sas' }>): HTMLElement[] {
    return [top(), h('div', { class: 'col page' },
      h('p', { class: 'eyebrow' }, 'Almost there'), h('h1', { class: 'title' }, 'Does your computer show this number?'),
      h('div', { class: 'panel' }, h('div', { class: 'sas', 'data-testid': 'sas' }, s.sas)),
      h('p', { class: 'lede' }, 'Then say yes on your computer. If the numbers differ or you did not start this, press Cancel.'),
      h('div', { class: 'pill wait' }, 'Waiting for your computer'),
      h('button', { class: 'ghost full', onclick: () => go({ t: 'pair', prefill: '' }) }, 'Cancel'))];
  }

  function statusPill(l: Link): HTMLElement {
    if (l.conn !== 'online') return h('span', { class: 'pill off', 'data-testid': 'conn' }, l.conn === 'killed' ? 'Switched off' : 'Connecting');
    if (l.hostOnline === false) return h('span', { class: 'pill off', 'data-testid': 'conn' }, 'Computer offline');
    return h('span', { class: 'pill live', 'data-testid': 'conn' }, 'Computer online');
  }

  function row(s: SessionState): HTMLElement {
    const waiting = !!s.pending;
    const what = !s.pending ? (s.status === 'working' ? 'working' : s.status) : s.pending.kind === 'permission' ? (s.pending.tool ? 'asks permission' : 'waiting for you') : s.pending.kind === 'question' ? 'asks a question' : 'waiting for your next instruction';
    return h('button', { class: `agent${waiting ? ' need' : s.status === 'working' ? ' work' : ''}`, 'data-testid': waiting ? 'waiting-row' : 'row', onclick: () => go({ t: 'card', sid: s.sid }) },
      h('span', { class: 'dot' }), h('span', { class: 'grow' }, h('b', {}, s.label), h('span', { class: 'sub' }, `Claude Code · ${what} · ${ago(s.since)}`)), waiting ? h('span', { class: 'chev' }, '›') : null);
  }

  function homeView(l: Link): HTMLElement[] {
    const st = l.state;
    const waiting = st?.sessions.filter((x) => x.pending) ?? [];
    const rest = st?.sessions.filter((x) => !x.pending) ?? [];
    return [top(h('button', { class: 'iconbtn', 'aria-label': 'Devices and settings', 'data-testid': 'gear', onclick: () => go({ t: 'devices' }) }, '⚙')), h('div', { class: 'col page' },
      h('div', { class: 'row between' }, statusPill(l), h('span', { class: 'mini' }, st ? `${st.host.name} · updated ${ago(Date.now())}` : '')),
      st?.host.paused ? h('div', { class: 'callout bad' }, 'Remote answers are paused on your computer.') : null,
      notice ? h('div', { class: `callout ${notice.tone}`, role: 'status', 'data-testid': 'notice' }, notice.text) : null,
      h('p', { class: 'h3' }, `Waiting for you · ${waiting.length}`),
      ...(waiting.length ? waiting.map((s) => row(s)) : [h('p', { class: 'fine', 'data-testid': 'none-waiting' }, st ? 'Nothing is waiting for you.' : 'Waiting for your computer.')]),
      rest.length ? h('p', { class: 'h3' }, `Not waiting · ${rest.length}`) : null,
      ...rest.map((s) => row(s)),
      h('p', { class: 'fine pushdown' }, 'Nothing here is stored on Botwarren\'s servers.'))];
  }

  function cardView(l: Link, sid: string): HTMLElement[] {
    const s = l.state?.sessions.find((x) => x.sid === sid);
    const back = h('button', { class: 'iconbtn', 'aria-label': 'Back', onclick: () => go({ t: 'home' }) }, '‹');
    if (!s) return [h('div', { class: 'topbar' }, back, h('span', { class: 'wm' }, 'Gone')), h('div', { class: 'col page' }, h('div', { class: 'callout' }, 'This agent is no longer listed.'))];
    const p = s.pending as (Pending & { can: { approve: boolean; reply: boolean } }) | undefined;
    const bar = h('div', { class: 'topbar' }, back, h('span', { class: 'wm small' }, s.label), h('span', { class: 'spacer' }));
    const messages = s.recent.map((m, i) => h('div', { class: `msg${p && i === s.recent.length - 1 ? ' ask' : ''}`, 'data-testid': 'recent' }, m.text));
    const body: (HTMLElement | null)[] = [];
    const send = async (a: 'approve' | 'deny' | 'reply', opt?: string): Promise<void> => {
      if (!p) return;
      busy = true; render();
      const r = await l.act(s.sid, p, a, opt);
      busy = false;
      notice = OUTCOME_TEXT[r];
      screen = { t: 'home' };
      render();
    };
    if (!p) body.push(h('div', { class: 'callout' }, s.status === 'working' ? 'Working. Nothing needs you right now.' : 'Not waiting for you.'));
    else if (p.kind === 'permission') {
      body.push(h('p', { class: 'eyebrow warm' }, p.tool ? 'Claude Code asks permission' : 'Claude Code is waiting for you'));
      if (p.summary || p.preview) body.push(h('div', { class: 'panel col card' }, h('span', { class: 'lbl' }, p.tool ? `${p.summary} (${p.tool})` : p.summary), p.preview ? h('div', { class: 'term', 'data-testid': 'preview' }, p.preview) : null, h('p', { class: 'fine' }, 'Shown as plain text, exactly what your agent asked.')));
    } else {
      body.push(h('p', { class: 'eyebrow warm' }, p.kind === 'question' ? 'Claude Code asks a question' : 'Claude Code is waiting for you'));
      if (p.kind === 'question' || p.kind === 'idle') body.push(h('div', { class: 'msg ask', 'data-testid': 'pending-summary' }, p.summary));
    }
    body.push(messages.length ? h('p', { class: 'h3' }, 'Last things it said') : null, ...messages);
    const actions: HTMLElement[] = [];
    if (p && p.kind === 'permission') {
      if (p.can.approve) actions.push(h('div', { class: 'row gap' }, h('button', { class: 'no-btn', 'data-testid': 'deny', disabled: busy, onclick: () => { void send('deny'); } }, 'Deny'), h('button', { class: 'ok-btn', 'data-testid': 'approve', disabled: busy, onclick: () => { void send('approve'); } }, 'Approve')));
      else actions.push(h('div', { class: 'callout warn', 'data-testid': 'terminal-only' }, 'Your computer cannot take an answer for this one from here. Answer at the terminal.'));
    } else if (p) {
      if (p.can.reply) {
        if (p.options?.length) { actions.push(h('p', { class: 'h3' }, 'Its options')); for (const o of p.options) actions.push(h('button', { class: 'nx', 'data-testid': `opt-${o.id}`, disabled: busy, onclick: () => { void send('reply', o.id); } }, o.label)); }
        actions.push(h('p', { class: 'h3' }, p.options?.length ? 'Or say' : 'Say'));
        actions.push(h('div', { class: 'row wrap gap' }, ...(l.state?.presets ?? []).map((pr) => h('button', { class: 'ghost', 'data-testid': `preset-${pr.id}`, disabled: busy, onclick: () => { void send('reply', pr.id); } }, pr.label))));
        actions.push(h('p', { class: 'fine' }, 'Replies come from a short list set on your computer. This page cannot send free text.'));
      } else actions.push(h('div', { class: 'callout warn', 'data-testid': 'terminal-only' }, 'Your computer cannot take a reply from here. Answer at the terminal.'));
    }
    if (p) actions.push(h('p', { class: 'fine center' }, 'Your computer re-checks this and can ask you to confirm there.'));
    return [bar, h('div', { class: 'col page' }, ...body, h('div', { class: 'pushdown col gap' }, ...actions))];
  }

  function devicesView(l: Link): HTMLElement[] {
    const devs = l.state?.host.devices ?? [];
    return [h('div', { class: 'topbar' }, h('button', { class: 'iconbtn', 'aria-label': 'Back', onclick: () => go({ t: 'home' }) }, '‹'), h('span', { class: 'wm small' }, 'Devices'), h('span', { class: 'spacer' })),
      h('div', { class: 'col page' },
        ...devs.map((d) => h('div', { class: 'card col', 'data-testid': 'device' }, h('div', { class: 'row between' }, h('b', {}, d.name, d.id8 === l.id8 ? h('span', { class: 'tag' }, 'this phone') : null), h('span', { class: d.id8 === l.id8 ? 'pill live' : 'pill off' }, d.id8 === l.id8 ? 'Paired' : d.lastSeen ? `Seen ${ago(d.lastSeen)}` : 'Never seen')))),
        devs.length === 0 ? h('div', { class: 'card col' }, h('b', {}, l.name, h('span', { class: 'tag' }, 'this phone'))) : null,
        h('div', { class: 'callout' }, h('b', {}, 'Removing a device'), ' is done on your computer: ', h('span', { class: 'mono' }, 'botwarren-companion devices revoke'), '. Lost a phone? Do that first.'),
        h('div', { class: 'card col' }, h('span', { class: 'lbl' }, 'This page'), h('span', { class: 'mini', 'data-testid': 'build-detail' }, `build ${info.build} · version ${info.version} · signed with release key ${info.keyId} · verified at start`)),
        h('button', { class: 'ghost danger full pushdown', 'data-testid': 'forget', onclick: () => { void (async () => { if (confirm('Forget this phone? You will need to pair it again.')) { await l.forget(); link = null; go({ t: 'pair', prefill: '' }); } })(); } }, 'Forget this phone'))];
  }

  function goneView(why: string): HTMLElement[] {
    return [top(), h('div', { class: 'col page' }, h('h1', { class: 'title' }, 'Remote approvals are off for this phone'), h('div', { class: 'callout bad', 'data-testid': 'gone' }, why), h('button', { class: 'cta full', onclick: () => go({ t: 'pair', prefill: '' }) }, 'Pair again'))];
  }

  let busy = false;
  function render(): void {
    if (unsupported) { mount(root!, ...[top(), h('div', { class: 'col page' }, h('div', { class: 'callout bad' }, 'This browser is too old. It cannot keep keys safely. Use a current Chrome, Safari or Firefox.'))]); return; }
    if (link?.revoked && screen.t !== 'gone' && screen.t !== 'pair') { link = null; screen = { t: 'gone', why: 'This phone was removed, or remote approvals were switched off for your account.' }; }
    let nodes: HTMLElement[];
    switch (screen.t) {
      case 'pair': nodes = pairView(screen); break;
      case 'sas': nodes = sasView(screen); break;
      case 'home': nodes = link ? homeView(link) : pairView({ t: 'pair', prefill: '' }); break;
      case 'card': nodes = link ? cardView(link, screen.sid) : []; break;
      case 'devices': nodes = link ? devicesView(link) : []; break;
      case 'gone': nodes = goneView(screen.why); break;
    }
    mount(root!, ...nodes);
    const waiting = link?.state?.sessions.filter((x) => x.pending).length ?? 0;
    document.title = waiting ? `(${waiting}) Botwarren Link` : 'Botwarren Link';
    if (waiting > lastWaiting && document.hidden && 'Notification' in globalThis && Notification.permission === 'granted') new Notification('Botwarren', { body: 'An agent is waiting for you', tag: 'bw-waiting' });
    lastWaiting = waiting;
  }

  function attach(l: Link): void { l.onChange(render); l.connect(); }
  function defaultName(): string { const ua = navigator.userAgent; return /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android phone' : 'Browser'; }

  window.addEventListener('hashchange', () => { if (screen.t === 'pair') { screen = { t: 'pair', prefill: codeFromHash() }; render(); } });
  setInterval(() => { if (screen.t === 'home' || screen.t === 'devices') render(); }, 30_000);
  if (link) attach(link);
  render();
  if (!unsupported && 'Notification' in globalThis && Notification.permission === 'default') { /* asked from the devices screen in a later version; never on load */ }
}
