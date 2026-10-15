/**
 * The Botwarren Companion web client (Apache-2.0). Started by the verified loader. See docs/PROTOCOL.md.
 */
import { Link, type Outcome } from './link.ts';
import { ago, h, mount } from './ui.ts';
import { clearShown, detectSupport, disable as disableAlerts, enable as enableAlerts, permission, wantsAlerts, type AlertResult, type SwPin } from './alerts.ts';
import type { Pending, SessionState } from '../../src/protocol/index.ts';

export interface BuildInfo { build: string; version: string; keyId: string; expires: string; sw?: SwPin }

type Tone = 'good' | 'warn' | 'bad' | 'info';
const RID = /^[a-z0-9-]{4,40}$/;
const ridFromHash = (): string | null => /^#\/r\/([a-z0-9-]{4,40})$/.exec(location.hash)?.[1] ?? null;

const ALERT_RESULT: Record<AlertResult, { tone: Tone; text: string }> = {
  ok: { tone: 'good', text: 'Alerts are set up on this phone.' },
  denied: { tone: 'warn', text: 'Notifications are blocked for this site. Allow them in the browser or phone settings, then try again.' },
  dismissed: { tone: 'warn', text: 'No permission was given, so alerts stay off.' },
  unavailable: { tone: 'warn', text: 'This relay is not set up to send alerts.' },
  bad_worker: { tone: 'bad', text: 'The alert helper on this page did not match its signature, so it was not started.' },
  failed: { tone: 'bad', text: 'Could not turn alerts on in this browser. Try again. On iPhone, open this page from the Home Screen.' },
  unsupported: { tone: 'warn', text: 'This browser cannot show alerts.' },
};

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
  let wantRid: string | null = ridFromHash();
  let wantTimer: ReturnType<typeof setTimeout> | null = null;
  let alertsBusy = false;
  let alertNote: { tone: Tone; text: string } | null = null;
  const support = detectSupport();
  let promptHidden = ((): boolean => { try { return localStorage.getItem('bw-alerts-dismissed') === '1'; } catch { return false; } })();
  const unsupported = !globalThis.crypto?.subtle || !globalThis.indexedDB;

  const go = (s: Screen): void => { screen = s; notice = null; render(); };
  const top = (right?: HTMLElement): HTMLElement => h('div', { class: 'topbar' }, h('span', { class: 'wm' }, 'Botwarren'), h('span', { class: 'wmsub' }, 'LINK'), h('span', { class: 'spacer' }), right ?? h('span', { class: 'mini', 'data-testid': 'build' }, `build ${info.build}`));

  function codeFromHash(): string { const m = /^#\/pair\/([0-9A-Za-z-]{16,24})$/.exec(location.hash); return m?.[1] ?? ''; }

  // ------------------------------------------------------------------ alerts
  type AlertView = 'unsupported' | 'ios-install' | 'denied' | 'off' | 'pending' | 'host_off' | 'on';
  function alertView(l: Link): AlertView {
    if (support !== 'ok') return support;
    if (permission() === 'denied') return 'denied';
    if (l.alerts?.on) return l.alerts.why === 'host_off' ? 'host_off' : 'on';
    return wantsAlerts() && l.alerts === null ? 'pending' : 'off';
  }

  async function toggleAlerts(l: Link, on: boolean): Promise<void> {
    alertsBusy = true; alertNote = null; render();
    if (on) {
      const r = await enableAlerts(l, info.sw);
      alertNote = r === 'ok' ? (l.alerts?.on ? { tone: 'good', text: 'Alerts are on. You will get "An agent is waiting for you" when one needs you.' } : { tone: 'warn', text: 'Alerts are set up on this phone. Your computer will start sending them once it is reachable.' }) : ALERT_RESULT[r];
    } else { await disableAlerts(l); alertNote = { tone: 'info', text: 'Alerts are off on this phone.' }; }
    alertsBusy = false; render();
  }

  function alertsCard(l: Link): HTMLElement {
    const v = alertView(l);
    const on = v === 'on' || v === 'host_off' || v === 'pending';
    const state = v === 'on' ? 'On' : v === 'pending' ? 'Setting up' : v === 'host_off' ? 'Off on computer' : 'Off';
    const body: (HTMLElement | null)[] = [
      h('div', { class: 'row between' }, h('b', {}, 'Alerts on this phone'), h('span', { class: v === 'on' ? 'pill live' : 'pill off', 'data-testid': 'alerts-state' }, state)),
      h('p', { class: 'fine' }, 'A notification that says only "An agent is waiting for you". It never shows your agents\' text, commands or project names, and your computer sends it without Botwarren being able to read it.'),
    ];
    if (v === 'ios-install') body.push(h('div', { class: 'callout warn', 'data-testid': 'alerts-ios' }, 'On iPhone and iPad, alerts work only from the Home Screen. Tap Share, then Add to Home Screen, open Botwarren Link from there, pair it again, and turn alerts on.'));
    else if (v === 'unsupported') body.push(h('div', { class: 'callout warn' }, 'This browser cannot show alerts.'));
    else if (v === 'denied') body.push(h('div', { class: 'callout warn', 'data-testid': 'alerts-denied' }, ALERT_RESULT.denied.text));
    else body.push(h('button', { class: on ? 'ghost full' : 'cta full', 'data-testid': 'alerts-toggle', disabled: alertsBusy, onclick: () => { void toggleAlerts(l, !on); } }, alertsBusy ? 'Working...' : on ? 'Turn alerts off' : 'Turn alerts on'));
    if (v === 'host_off') body.push(h('div', { class: 'callout warn' }, 'Alerts are switched off on your computer. Switch them on there: botwarren-companion alerts on'));
    if (alertNote) body.push(h('div', { class: `callout ${alertNote.tone}`, role: 'status', 'data-testid': 'alerts-note' }, alertNote.text));
    return h('div', { class: 'card col', 'data-testid': 'alerts-card' }, ...body);
  }

  /** a one-time nudge on the home screen; "Not now" is remembered on this phone */
  function alertsPrompt(l: Link): HTMLElement | null {
    const v = alertView(l);
    if (promptHidden || (v !== 'off' && v !== 'ios-install')) return null;
    const hide = (): void => { promptHidden = true; try { localStorage.setItem('bw-alerts-dismissed', '1'); } catch { /* shown again next visit */ } render(); };
    return h('div', { class: 'callout', 'data-testid': 'alerts-prompt' },
      h('b', {}, 'Get an alert when an agent is waiting. '), v === 'ios-install' ? 'On iPhone this needs the Home Screen: see Devices and settings.' : 'No text, no names: only that it needs you.',
      h('div', { class: 'row gap wrap mt' }, v === 'off' ? h('button', { class: 'ghost', 'data-testid': 'alerts-prompt-on', onclick: () => { void toggleAlerts(l, true); } }, 'Turn on') : null, h('button', { class: 'ghost', 'data-testid': 'alerts-prompt-off', onclick: hide }, 'Not now')));
  }

  /** a tap on an alert (or a link to one) opens that request, if it is still waiting, and says so truthfully if it is not */
  function resolveWant(): void {
    if (wantRid === null) return;
    if (!link) { wantRid = null; return; }
    if (!link.state) return; // wait for the first state (a timer gives up)
    const rid = wantRid; wantRid = null;
    if (wantTimer) { clearTimeout(wantTimer); wantTimer = null; }
    try { history.replaceState(null, '', location.pathname); } catch { /* the address stays */ }
    const s = rid === 'any' ? undefined : link.state.sessions.find((x) => x.pending?.rid === rid);
    if (s) { screen = { t: 'card', sid: s.sid }; notice = null; return; }
    screen = { t: 'home' };
    notice = rid === 'any' ? null : { tone: 'info', text: 'That request was already answered, or it expired. Nothing is waiting on it now.' };
  }
  function want(rid: string | null): void {
    wantRid = rid ?? 'any';
    if (wantTimer) clearTimeout(wantTimer);
    wantTimer = setTimeout(() => { if (wantRid !== null) { wantRid = null; notice = { tone: 'warn', text: 'No answer from your computer yet. It may be offline.' }; render(); } }, 10_000);
    render();
  }

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
      alertsPrompt(l),
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
        alertsCard(l),
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
    resolveWant();
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
    if (waiting === 0 && lastWaiting > 0) void clearShown(); // answered somewhere: the alert in the tray would only be stale
    lastWaiting = waiting;
  }

  function attach(l: Link): void { l.onChange(render); l.connect(); }
  function defaultName(): string { const ua = navigator.userAgent; return /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android phone' : 'Browser'; }

  window.addEventListener('hashchange', () => {
    if (screen.t === 'pair') { screen = { t: 'pair', prefill: codeFromHash() }; render(); return; }
    const rid = ridFromHash();
    if (rid) want(rid); else if (location.hash === '#/waiting') want(null);
  });
  // a tap on an alert while this page is already open arrives from the service worker
  try {
    navigator.serviceWorker?.addEventListener('message', (e: MessageEvent) => {
      const d = e.data as { t?: unknown; rid?: unknown } | null;
      if (d?.t === 'bw-open') want(typeof d.rid === 'string' && RID.test(d.rid) ? d.rid : null);
    });
  } catch { /* no service worker support: alerts are not offered either */ }
  setInterval(() => { if (screen.t === 'home' || screen.t === 'devices') render(); }, 30_000);
  if (link) attach(link);
  render();
  if (wantRid !== null) want(wantRid);
  if (location.hash === '#/waiting') want(null);
}
