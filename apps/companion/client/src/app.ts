/**
 * The Botwarren Companion web client (Apache-2.0). Started by the verified loader. See docs/PROTOCOL.md.
 */
import { Link, type Outcome } from './link.ts';
import { ago, h, mount } from './ui.ts';
import { clearShown, detectSupport, disable as disableAlerts, enable as enableAlerts, permission, sendTest, wantsAlerts, type AlertResult, type SwPin, type TestResult } from './alerts.ts';
import { termBox } from './terminal.ts';
import type { Pending, SessionState } from '../../src/protocol/index.ts';
import { fromLink, type ControlTransport } from './control/adapter.ts';
import { createProtocol3Transport } from './control/protocol3.ts';
import { ControlUi, harnessName, HARNESS_NAME } from './control/ui.ts';
import type { CSession, ControlApi } from './control/types.ts';

export interface BuildInfo { build: string; version: string; keyId: string; expires: string; sw?: SwPin }

type Tone = 'good' | 'warn' | 'bad' | 'info';
const RID = /^[a-z0-9-]{4,40}$/;
const ridFromHash = (): string | null => /^#\/r\/([a-z0-9-]{4,40})$/.exec(location.hash)?.[1] ?? null;

const RESTART = 'On your computer run "botwarren-companion status": it says which version is running. Restart the Companion there (Linux: systemctl --user restart botwarren-companion; Mac or Windows: restart it or sign out and in), then try again.';
const ALERT_RESULT: Record<AlertResult, { tone: Tone; text: string }> = {
  ok: { tone: 'good', text: 'Alerts are on. You will get "An agent is waiting for you" when one needs you. Press "Send a test alert" to check one reaches this phone.' },
  ok_host_off: { tone: 'warn', text: 'Your computer has this phone set up, but alerts are switched off on the computer itself. On your computer run: botwarren-companion alerts on' },
  waiting_computer: { tone: 'warn', text: 'This phone is ready, but your computer cannot be reached right now, so nothing is confirmed yet. It is confirmed automatically when the computer is back online. Alerts are not working until then.' },
  host_old: { tone: 'bad', text: `Your computer is online, but the Companion running there is an older version that does not know about alerts. ${RESTART}` },
  host_silent: { tone: 'bad', text: `Your computer is online but did not answer within 12 seconds, so alerts are not confirmed. Try again. If it keeps happening: ${RESTART}` },
  host_rejected: { tone: 'bad', text: 'Your computer refused this phone\'s alert address. Turn alerts off and on again. If it keeps happening, tell support@turbokast.com.' },
  denied: { tone: 'warn', text: 'Notifications are blocked for this site. Allow them in the browser or phone settings, then try again.' },
  dismissed: { tone: 'warn', text: 'No permission was given, so alerts stay off. Tap Turn alerts on and choose Allow.' },
  prompt_timeout: { tone: 'warn', text: 'The permission question was not answered, so alerts stay off. Tap Turn alerts on and choose Allow.' },
  relay_unreachable: { tone: 'bad', text: 'Could not reach the Botwarren relay to set up alerts. Check this phone is online, then try again.' },
  unavailable: { tone: 'warn', text: 'This relay is not set up to send alerts.' },
  bad_worker: { tone: 'bad', text: 'The alert helper on this page did not match its signature, so it was not started.' },
  worker_unreachable: { tone: 'bad', text: 'The alert helper could not be downloaded. Check your connection and try again.' },
  worker_register: { tone: 'bad', text: 'This browser refused to start the alert helper. Close other tabs of this page and try again. If it still fails, clear this site\'s data in the browser settings and pair again.' },
  worker_timeout: { tone: 'bad', text: 'The alert helper did not start in time. Close and reopen this page, then try again.' },
  push_service: { tone: 'bad', text: 'This phone could not reach its push service. Chrome on Android uses Google\'s: check you are online, that Data Saver and battery limits are off for Chrome, and that Google Play services is up to date, then try again.' },
  subscribe_denied: { tone: 'warn', text: 'The browser would not allow alerts. In your phone settings, turn Notifications on for Chrome and for this site, then try again.' },
  subscribe_timeout: { tone: 'bad', text: 'The phone\'s push service did not answer within 25 seconds. Check your connection and try again.' },
  subscribe_failed: { tone: 'bad', text: 'This browser could not set up alerts. Try again. On iPhone, open this page from the Home Screen.' },
  no_keys: { tone: 'bad', text: 'The browser gave back an incomplete alert address. Turn alerts off and on again.' },
  failed: { tone: 'bad', text: 'Could not turn alerts on in this browser. Try again. On iPhone, open this page from the Home Screen.' },
  unsupported: { tone: 'warn', text: 'This browser cannot show alerts.' },
  insecure: { tone: 'warn', text: 'Alerts need a secure (https) page. Open the address your computer showed, which starts with https.' },
};

const TEST_RESULT: Record<TestResult, { tone: Tone; text: string }> = {
  arrived: { tone: 'good', text: 'Test alert received. It went from this phone to your computer, to the push service, and back to this phone. Alerts work.' },
  not_arrived: { tone: 'bad', text: 'The push service accepted the test, but nothing reached this phone within 15 seconds. Check that Notifications are allowed for Chrome and this site, and that battery saver or Data Saver is not blocking Chrome, then try again.' },
  no_reply: { tone: 'bad', text: `Your computer did not answer the test. It may be offline, or its Companion is older than 0.1.2, or was not restarted after an update. ${RESTART}` },
  no_subscription: { tone: 'warn', text: 'This phone has no alert address yet. Turn alerts on first.' },
  no_permission: { tone: 'warn', text: 'Notifications are not allowed for this site. Allow them in the browser or phone settings, then try again.' },
  alerts_off: { tone: 'warn', text: 'Alerts are switched off on your computer. On your computer run: botwarren-companion alerts on' },
  rate_limited: { tone: 'warn', text: 'Too many tests. Wait ten seconds (at most ten an hour).' },
  relay_off: { tone: 'warn', text: 'The relay cannot send alerts right now (it is switched off, or your computer lost its connection to it). Try again in a minute.' },
  relay_busy: { tone: 'warn', text: 'The relay is limiting alerts for the moment. Wait a minute and try again.' },
  bad_endpoint: { tone: 'bad', text: 'This phone\'s push address is not one the relay will call. Turn alerts off and on again.' },
  push_gone: { tone: 'warn', text: 'The push service says this phone\'s alert address no longer exists. Turn alerts off and on again.' },
  push_refused: { tone: 'bad', text: 'The push service refused the test. Turn alerts off and on again.' },
  not_sent: { tone: 'bad', text: 'Your computer could not hand the test to the relay in time. Try again.' },
  offline: { tone: 'warn', text: 'This phone is not connected to your computer. Wait for "Computer online", then try again.' },
  unsupported: { tone: 'warn', text: 'This browser cannot show alerts.' },
};
const TEST_STEP: Record<'asked' | 'computer' | 'pushed', string> = {
  asked: 'Test: asking your computer to send an alert...',
  computer: 'Test: your computer has it. Handing it to the push service...',
  pushed: 'Test: the push service has it. Waiting for it to reach this phone...',
};

type Screen = { t: 'pair'; prefill: string; error?: string } | { t: 'sas'; sas: string; note?: string } | { t: 'home'; sel?: string } | { t: 'card'; sid: string } | { t: 'devices' } | { t: 'gone'; why: string } | { t: 'audit' } | { t: 'start' };

const OUTCOME_TEXT: Record<Outcome | 'timeout' | 'offline', { tone: 'good' | 'warn' | 'bad' | 'info'; text: string }> = {
  applied: { tone: 'good', text: 'Done. Your agent is working again.' },
  sent: { tone: 'info', text: 'Sent. Your answer reached the agent, but it has not confirmed yet, so this is not called done. The card updates when the agent moves on.' },
  denied: { tone: 'good', text: 'Denied. Nothing ran.' },
  expired: { tone: 'bad', text: 'Expired. Your agent stopped waiting. Nothing was sent.' },
  stale: { tone: 'warn', text: 'This changed. Your agent asked something new, so this card was closed. Open it again to see what it asks now.' },
  rejected: { tone: 'warn', text: 'Your computer did not accept that here. Answer on your computer.' },
  needs_local: { tone: 'warn', text: 'Waiting for you on your computer. Your computer asks you to confirm this one there.' },
  paused: { tone: 'bad', text: 'Remote answers are paused on your computer.' },
  rate_limited: { tone: 'warn', text: 'Too many answers in a short time. Wait a minute.' },
  failed: { tone: 'bad', text: 'Your agent can no longer be reached. It may have been answered at the terminal.' },
  timeout: { tone: 'warn', text: 'No answer from your computer yet. It may be offline.' },
  offline: { tone: 'bad', text: 'Not connected. Reconnecting.' },
};

/** the name of each kind of agent on a card; a kind this page does not know (a newer companion) is "Another agent" */
export { HARNESS_NAME };
export const agentName = (s: Pick<SessionState, 'agent'>): string => harnessName(s.agent);

/** words for the risk chips; a tag this page does not know is shown as its own words (letters and underscores only, so it cannot carry anything else) */
const RISK_TEXT: Record<string, { text: string; tone: 'warn' | 'bad' | 'info' }> = {
  outside_workspace: { text: 'Outside the project', tone: 'warn' },
  network: { text: 'Network', tone: 'bad' },
  protected_write: { text: 'Protected file', tone: 'warn' },
  escalated: { text: 'Wider access', tone: 'bad' },
  destructive: { text: 'Destructive', tone: 'bad' },
  unknown_tool: { text: 'Unknown tool', tone: 'warn' },
  screen_sourced: { text: 'From the terminal screen', tone: 'info' },
};
export const riskChip = (tag: string): { text: string; tone: 'warn' | 'bad' | 'info' } => RISK_TEXT[tag] ?? { text: tag.replace(/_/g, ' '), tone: 'warn' };

export interface StartOptions {
  /** test harness: a scripted ControlApi instead of the real link (no pairing, no alerts) */
  api?: ControlApi;
  /** protocol 3 commands, when the computer's Companion supports them (supplied by the core's client module) */
  transport?: ControlTransport;
}

const OPEN_REF = /^#\/open\/([A-Za-z0-9_-]{4,64})$/;

export async function start(info: BuildInfo, opts: StartOptions = {}): Promise<void> {
  const root = document.getElementById('root');
  if (!root) return;
  let link = opts.api ? null : await Link.load().catch(() => null);
  let screen: Screen = link || opts.api ? { t: 'home' } : { t: 'pair', prefill: codeFromHash() };
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
  type AlertView = 'unsupported' | 'ios-install' | 'insecure' | 'denied' | 'off' | 'working' | 'unconfirmed' | 'host_old' | 'waiting_computer' | 'host_off' | 'on';
  let testBusy = false;
  function alertView(l: Link): AlertView {
    if (support !== 'ok') return support;
    if (permission() === 'denied') return 'denied';
    if (l.alerts?.on) return l.alerts.why === 'host_off' ? 'host_off' : 'on';
    if (alertsBusy) return 'working';
    if (!wantsAlerts()) return 'off';
    // the person turned alerts on here and the computer has not confirmed: say why, never just "setting up"
    if (l.hostLacksAlerts()) return 'host_old';
    if (l.conn !== 'online' || l.hostOnline === false) return 'waiting_computer';
    return Date.now() - l.connectedAt < 8000 ? 'working' : 'unconfirmed';
  }
  const PILL: Record<AlertView, string> = { unsupported: 'Unavailable', 'ios-install': 'Off', insecure: 'Unavailable', denied: 'Off', off: 'Off', working: 'Working', unconfirmed: 'Not confirmed', host_old: 'Computer out of date', waiting_computer: 'Waiting for computer', host_off: 'Off on computer', on: 'On' };

  async function toggleAlerts(l: Link, on: boolean): Promise<void> {
    alertsBusy = true; alertNote = null; render();
    try {
      if (on) alertNote = ALERT_RESULT[await enableAlerts(l, info.sw)];
      else { await disableAlerts(l); alertNote = { tone: 'info', text: 'Alerts are off on this phone.' }; }
    } catch { alertNote = ALERT_RESULT.failed; } // nothing may leave the card on "working"
    alertsBusy = false; render();
  }

  async function runTest(l: Link): Promise<void> {
    testBusy = true; alertNote = { tone: 'info', text: TEST_STEP.asked }; render();
    try { const r = await sendTest(l, (st) => { alertNote = { tone: 'info', text: TEST_STEP[st] }; render(); }); alertNote = TEST_RESULT[r]; } catch { alertNote = TEST_RESULT.not_sent; }
    testBusy = false; render();
  }

  function alertsCard(l: Link): HTMLElement {
    const v = alertView(l);
    const confirmed = v === 'on' || v === 'host_off';
    const retry = v === 'unconfirmed' || v === 'host_old';
    const body: (HTMLElement | null)[] = [
      h('div', { class: 'row between' }, h('b', {}, 'Alerts on this phone'), h('span', { class: v === 'on' ? 'pill live' : v === 'working' ? 'pill wait' : 'pill off', 'data-testid': 'alerts-state' }, PILL[v])),
      h('p', { class: 'fine' }, 'A notification that says only "An agent is waiting for you". It never shows your agents\' text, commands or project names, and your computer sends it without Botwarren being able to read it.'),
    ];
    if (v === 'ios-install') body.push(h('div', { class: 'callout warn', 'data-testid': 'alerts-ios' }, 'On iPhone and iPad, alerts work only from the Home Screen. Tap Share, then Add to Home Screen, open Botwarren Link from there, pair it again, and turn alerts on.'));
    else if (v === 'unsupported') body.push(h('div', { class: 'callout warn' }, ALERT_RESULT.unsupported.text));
    else if (v === 'insecure') body.push(h('div', { class: 'callout warn' }, ALERT_RESULT.insecure.text));
    else if (v === 'denied') body.push(h('div', { class: 'callout warn', 'data-testid': 'alerts-denied' }, ALERT_RESULT.denied.text));
    else {
      const turnOn = v === 'off' || retry;
      body.push(h('button', { class: turnOn ? 'cta full' : 'ghost full', 'data-testid': 'alerts-toggle', disabled: alertsBusy || testBusy, onclick: () => { void toggleAlerts(l, turnOn); } },
        alertsBusy ? 'Working...' : retry ? 'Try again' : turnOn ? 'Turn alerts on' : 'Turn alerts off'));
      if (retry) body.push(h('button', { class: 'ghost full', 'data-testid': 'alerts-off', disabled: alertsBusy, onclick: () => { void toggleAlerts(l, false); } }, 'Turn alerts off'));
      if (confirmed) body.push(h('button', { class: 'ghost full', 'data-testid': 'alerts-test', disabled: alertsBusy || testBusy, onclick: () => { void runTest(l); } }, testBusy ? 'Testing...' : 'Send a test alert'));
    }
    if (v === 'host_off' && !alertNote) body.push(h('div', { class: 'callout warn' }, ALERT_RESULT.ok_host_off.text));
    if (v === 'host_old' && !alertNote) body.push(h('div', { class: 'callout bad', 'data-testid': 'alerts-host-old' }, ALERT_RESULT.host_old.text));
    if (v === 'waiting_computer' && !alertNote) body.push(h('div', { class: 'callout warn', 'data-testid': 'alerts-waiting' }, ALERT_RESULT.waiting_computer.text));
    if (v === 'unconfirmed' && !alertNote) body.push(h('div', { class: 'callout bad', 'data-testid': 'alerts-unconfirmed' }, ALERT_RESULT.host_silent.text));
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
    const u = ui();
    if (!u) { wantRid = null; return; }
    if (!u.api.host().ready) return; // wait for the first state (a timer gives up)
    const rid = wantRid; wantRid = null;
    if (wantTimer) { clearTimeout(wantTimer); wantTimer = null; }
    try { history.replaceState(null, '', location.pathname); } catch { /* the address stays */ }
    const s = rid === 'any' ? undefined : u.api.sessions().find((x) => x.state.pending?.rid === rid);
    if (s) { screen = wide() ? { t: 'home', sel: s.sid } : { t: 'card', sid: s.sid }; notice = null; return; }
    screen = { t: 'home' };
    notice = rid === 'any' ? null : { tone: 'info', text: 'That request was already answered, or it expired. Nothing is waiting on it now.' };
  }
  /** the station's "Control" link (#/open/<ref>) opens the session of that robot, if it is one of this computer's right now */
  let wantRef: string | null = OPEN_REF.exec(location.hash)?.[1] ?? null;
  let refTimer: ReturnType<typeof setTimeout> | null = null;
  function resolveRef(): void {
    if (wantRef === null) return;
    const u = ui();
    if (!u) { wantRef = null; return; }
    if (!u.api.host().ready) return;
    const ref = wantRef; wantRef = null;
    if (refTimer) { clearTimeout(refTimer); refTimer = null; }
    try { history.replaceState(null, '', location.pathname); } catch { /* the address stays */ }
    const s = u.api.sessions().find((x) => x.station === ref || x.sid === ref);
    if (s) { screen = wide() ? { t: 'home', sel: s.sid } : { t: 'card', sid: s.sid }; notice = null; return; }
    screen = { t: 'home' };
    notice = { tone: 'info', text: 'That robot is not one of the sessions on your computer right now. It may have finished, or it is on another computer.' };
  }
  function wantRobot(ref: string): void {
    wantRef = ref;
    if (refTimer) clearTimeout(refTimer);
    refTimer = setTimeout(() => { if (wantRef !== null) { wantRef = null; notice = { tone: 'warn', text: 'No answer from your computer yet. It may be offline.' }; render(); } }, 10_000);
    render();
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

  const wide = (): boolean => { try { return window.matchMedia('(min-width: 900px)').matches; } catch { return false; } };
  const openSession = (sid: string): void => { if (wide()) { screen = { t: 'home', sel: sid }; notice = null; render(); } else go({ t: 'card', sid }); };

  /** the person's own session list and, on a wide screen, the open session beside it */
  function homeView(sel: string | null): HTMLElement[] {
    const u = ui();
    if (!u) return pairView({ t: 'pair', prefill: '' });
    const l = link;
    const st = l?.state;
    const sessions = u.api.sessions();
    const chosen = wide() ? (sel && sessions.some((x) => x.sid === sel) ? sel : (sessions.find((x) => x.status === 'needs_you') ?? sessions.find((x) => x.status !== 'ended') ?? sessions[0])?.sid ?? null) : null;
    u.syncWatch(chosen);
    const ho = u.api.host();
    const gear = l ? h('button', { class: 'iconbtn', 'aria-label': 'Devices and settings', 'data-testid': 'gear', onclick: () => go({ t: 'devices' }) }, '⚙') : undefined;
    const right = h('span', { class: 'row gap' }, u.controlChip(), gear ?? null);
    const left: (HTMLElement | null)[] = [
      ...u.banners(),
      ho.paused ? h('div', { class: 'callout bad' }, 'Remote answers are paused on your computer.') : null,
      ho.away ? h('div', { class: 'callout warn', 'data-testid': 'away' }, h('b', {}, 'You are away. '), 'Codex and Muse wait for you up to 45 seconds before their own question shows on your computer. Turn it off on your computer with ', h('span', { class: 'mono' }, 'botwarren-companion away off'), '.') : null,
      notice ? h('div', { class: `callout ${notice.tone}`, role: 'status', 'data-testid': 'notice' }, notice.text) : null,
      l?.badState ? h('div', { class: 'callout warn', 'data-testid': 'bad-state' }, 'Your computer sent an update this page could not read, so what is shown may be out of date. Reload this page. If it keeps happening, the Companion on your computer and this page are different versions: update the Companion.') : null,
      l ? alertsPrompt(l) : null,
      ...u.sessionList(chosen, openSession),
      ho.supported ? h('div', { class: 'row gap pushdown' }, h('button', { class: 'ghost sp', 'data-testid': 'start-open', onclick: () => go({ t: 'start' }) }, '+ Start a session'), h('button', { class: 'ghost sp', 'data-testid': 'audit-open', onclick: () => { go({ t: 'audit' }); void u.loadAudit(); } }, 'Activity')) : null,
      h('p', { class: 'fine pushdown' }, 'Nothing here is stored on Botwarren\'s servers.'),
    ];
    if (!wide()) return [top(right), h('div', { class: 'col page' }, ...left)];
    const cs = chosen ? sessions.find((x) => x.sid === chosen) : undefined;
    return [top(right), h('div', { class: 'panes' }, h('div', { class: 'col pane-list page' }, ...left),
      h('div', { class: 'col pane-detail' }, cs ? h('div', { class: 'pane-head' }, h('span', { class: 'wm' }, cs.label), h('span', { class: 'spacer' }), u.statusChipFor(cs)) : null,
        h('div', { class: 'col page', 'data-testid': 'detail' }, ...(cs ? detailNodes(cs) : [h('div', { class: 'callout', 'data-testid': 'pick' }, 'Pick a session on the left.')]))))];
  }

  let busy = false;
  function cardView(sid: string): HTMLElement[] {
    const u = ui();
    const cs = u?.api.sessions().find((x) => x.sid === sid);
    const back = h('button', { class: 'iconbtn', 'aria-label': 'Back', onclick: () => go({ t: 'home' }) }, '‹');
    if (!u || !cs) { u?.syncWatch(null); return [h('div', { class: 'topbar' }, back, h('span', { class: 'wm' }, 'Gone')), h('div', { class: 'col page' }, h('div', { class: 'callout' }, 'This agent is no longer listed.'))]; }
    u.syncWatch(sid);
    const bar = h('div', { class: 'topbar' }, back, h('span', { class: 'wm small' }, cs.label), h('span', { class: 'spacer' }), u.statusChipFor(cs));
    return [bar, ...u.banners(), h('div', { class: 'col page fit', 'data-testid': 'detail' }, ...detailNodes(cs))];
  }

  /** one session: what it asks (approval, question), its live tail, the message box and Stop */
  function detailNodes(cs: CSession): HTMLElement[] {
    const u = ui()!;
    const l = u.api;
    const s = cs.state;
    const p = s.pending as (Pending & { can: { approve: boolean; reply: boolean } }) | undefined;
    const messages = s.recent.map((m, i) => termBox({ key: `${s.sid}:m:${m.ts}:${i}`, title: `Message ${i + 1} of ${s.recent.length}`, text: m.text, cut: m.cut, ask: !!p && i === s.recent.length - 1, testid: 'recent' }));
    const body: (HTMLElement | null)[] = [];
    const send = async (a: 'approve' | 'deny' | 'reply', opt?: string): Promise<void> => {
      if (!p) return;
      busy = true; render();
      const r = await l.answer(cs, a, opt);
      busy = false;
      notice = OUTCOME_TEXT[r];
      screen = { t: 'home' };
      render();
    };
    const who = agentName(s);
    const fromScreen = p?.source === 'screen';
    const chips = [...(p?.risk ?? []), ...(fromScreen && !(p?.risk ?? []).includes('screen_sourced') ? ['screen_sourced'] : [])].map(riskChip);
    const chipRow = chips.length ? h('div', { class: 'row wrap gap', 'data-testid': 'risk' }, ...chips.map((c) => h('span', { class: `chip${c.tone === 'bad' ? ' bad' : c.tone === 'info' ? ' info' : ''}` }, c.text))) : null;
    const head = u.sessionChips(cs);
    if (!p) {
      body.push(head);
      if (cs.tail) body.push(u.tailBox(cs));
      else body.push(h('div', { class: 'callout' }, s.status === 'working' ? 'Working. Nothing needs you right now.' : 'Not waiting for you.'), s.mode === 'bypass' ? h('div', { class: 'callout warn', 'data-testid': 'bypass' }, h('b', {}, 'No approval prompts. '), 'This agent runs without asking permission, so there is nothing to approve. Botwarren shows its state only.') : null, messages.length ? h('p', { class: 'h3' }, 'Last things it said') : null, ...messages);
      body.push(...u.composeArea(cs), ...u.stopArea(cs));
      return body.filter((x): x is HTMLElement => x !== null);
    }
    body.push(head);
    if (p.kind === 'permission') {
      body.push(h('p', { class: 'eyebrow warm' }, p.tool ? `${who} asks permission` : `${who} is waiting for you`), chipRow);
      if (p.summary || p.preview) {
        const pv = p.preview ? termBox({ key: `${s.sid}:p:${p.rid}`, title: fromScreen ? 'From the terminal screen' : p.tool ?? 'Request', text: p.preview, cut: p.cut, ask: true, testid: 'preview' }) : null;
        if (pv && fromScreen) pv.classList.add('screen');
        body.push(h('div', { class: 'panel col card' }, h('span', { class: 'lbl' }, fromScreen ? 'What the screen shows' : p.tool ? `${p.summary} (${p.tool})` : p.summary), pv, h('p', { class: 'fine' }, fromScreen ? `Read from the terminal, not from ${who}. Treat it as a hint: it can be out of date.` : 'Shown as plain text, exactly what your agent asked.')));
      }
    } else {
      body.push(h('p', { class: 'eyebrow warm' }, p.kind === 'question' ? `${who} asks a question` : `${who} is waiting for you`), chipRow);
      if (p.kind === 'question' || p.kind === 'idle') body.push(h('div', { class: 'msg ask', 'data-testid': 'pending-summary' }, p.summary), h('p', { class: 'fine' }, 'The agent\'s own words. Botwarren cannot check them.'));
    }
    body.push(messages.length ? h('p', { class: 'h3' }, 'Last things it said') : null, ...messages);
    const actions: HTMLElement[] = [];
    const none = (what: string): HTMLElement => h('div', { class: 'callout warn', 'data-testid': 'terminal-only' }, h('b', {}, 'Answer on your computer. '), s.mode === 'bypass' ? 'This agent runs without approval prompts, so there is nothing to approve.' : `${who} cannot take ${what} from here. Botwarren only tells you that it is waiting.`);
    if (p.kind === 'permission') {
      if (p.can.approve || p.can.deny) {
        actions.push(h('div', { class: 'row gap' }, h('button', { class: 'no-btn', 'data-testid': 'deny', disabled: busy, onclick: () => { void send('deny'); } }, 'Deny'), p.can.approve ? h('button', { class: 'ok-btn', 'data-testid': 'approve', disabled: busy, onclick: () => { void send('approve'); } }, 'Approve once') : null));
        const say = (p.denyWith ?? []).map((id) => l.presets().find((pr) => pr.id === id)).filter((pr): pr is { id: string; label: string } => !!pr);
        if (say.length) {
          actions.push(h('p', { class: 'h3' }, 'Deny and say'));
          actions.push(h('div', { class: 'row wrap gap' }, ...say.map((pr) => h('button', { class: 'ghost', 'data-testid': `deny-say-${pr.id}`, disabled: busy, onclick: () => { void send('reply', pr.id); } }, pr.label))));
        }
        actions.push(p.can.approve ? h('p', { class: 'fine' }, 'Approve means this one request only.') : h('div', { class: 'callout warn', 'data-testid': 'deny-only' }, h('b', {}, 'You can deny this from here. '), `To approve it, answer on your computer: ${who} does not take an approval from outside.`));
      } else actions.push(p.cut ? h('div', { class: 'callout warn', 'data-testid': 'terminal-only' }, h('b', {}, 'Answer on your computer. '), 'This request is too long to show in full here, so it cannot be approved from your phone.') : none('an answer'));
    } else {
      if (p.can.reply) {
        if (p.options?.length) { actions.push(h('p', { class: 'h3' }, 'Its options')); for (const o of p.options) actions.push(h('button', { class: 'nx', 'data-testid': `opt-${o.id}`, disabled: busy, onclick: () => { void send('reply', o.id); } }, o.label)); }
        actions.push(h('p', { class: 'h3' }, p.options?.length ? 'Or say' : 'Say'));
        actions.push(h('div', { class: 'row wrap gap' }, ...l.presets().map((pr) => h('button', { class: 'ghost', 'data-testid': `preset-${pr.id}`, disabled: busy, onclick: () => { void send('reply', pr.id); } }, pr.label))));
        if (u.canFreeText(cs)) actions.push(h('p', { class: 'h3' }, 'Or answer in your own words'), ...u.composeArea(cs, true));
        else actions.push(h('p', { class: 'fine' }, 'Replies come from a short list set on your computer. This page cannot send free text here.'));
      } else actions.push(none('a reply'));
    }
    if (p.can.approve || p.can.reply || p.can.deny) actions.push(h('p', { class: 'fine center' }, 'Your computer re-checks this and can ask you to confirm there.'));
    return [...body.filter((x): x is HTMLElement => x !== null), h('div', { class: 'pushdown col gap' }, ...actions)];
  }

  function startScreen(): HTMLElement[] {
    const u = ui();
    const close = (): void => { screen = { t: 'home' }; notice = { tone: 'good', text: 'Started. The new session appears in your list.' }; };
    return [h('div', { class: 'topbar' }, h('button', { class: 'iconbtn', 'aria-label': 'Close', 'data-testid': 'start-close', onclick: () => go({ t: 'home' }) }, '✕'), h('span', { class: 'wm small' }, 'Start a session'), h('span', { class: 'spacer' })),
      h('div', { class: 'col page' }, ...(u ? u.startView(close) : []))];
  }

  function auditScreen(): HTMLElement[] {
    const u = ui();
    return [h('div', { class: 'topbar' }, h('button', { class: 'iconbtn', 'aria-label': 'Back', onclick: () => go({ t: 'home' }) }, '‹'), h('span', { class: 'wm small' }, 'Activity'), h('span', { class: 'spacer' })),
      h('div', { class: 'col page', 'data-testid': 'audit' }, ...(u ? u.auditView() : []))];
  }

  function devicesView(l: Link): HTMLElement[] {
    const devs = l.state?.host.devices ?? [];
    return [h('div', { class: 'topbar' }, h('button', { class: 'iconbtn', 'aria-label': 'Back', onclick: () => go({ t: 'home' }) }, '‹'), h('span', { class: 'wm small' }, 'Devices'), h('span', { class: 'spacer' })),
      h('div', { class: 'col page' },
        ...devs.map((d) => h('div', { class: 'card col', 'data-testid': 'device' }, h('div', { class: 'row between' }, h('b', {}, d.name, d.id8 === l.id8 ? h('span', { class: 'tag' }, 'this phone') : null), h('span', { class: d.id8 === l.id8 ? 'pill live' : 'pill off' }, d.id8 === l.id8 ? 'Paired' : d.lastSeen ? `Seen ${ago(d.lastSeen)}` : 'Never seen')))),
        devs.length === 0 ? h('div', { class: 'card col' }, h('b', {}, l.name, h('span', { class: 'tag' }, 'this phone'))) : null,
        ui()?.lockCard() ?? null,
        alertsCard(l),
        h('div', { class: 'callout' }, h('b', {}, 'Removing a device'), ' is done on your computer: ', h('span', { class: 'mono' }, 'botwarren-companion devices revoke'), '. Lost a phone? Do that first.'),
        h('div', { class: 'card col' }, h('span', { class: 'lbl' }, 'This page'), h('span', { class: 'mini', 'data-testid': 'build-detail' }, `build ${info.build} · version ${info.version} · signed with release key ${info.keyId} · verified at start`)),
        h('button', { class: 'ghost danger full pushdown', 'data-testid': 'forget', onclick: () => { void (async () => { if (confirm('Forget this phone? You will need to pair it again.')) { await l.forget(); link = null; go({ t: 'pair', prefill: '' }); } })(); } }, 'Forget this phone'))];
  }

  function goneView(why: string): HTMLElement[] {
    return [top(), h('div', { class: 'col page' }, h('h1', { class: 'title' }, 'Remote approvals are off for this phone'), h('div', { class: 'callout bad', 'data-testid': 'gone' }, why), h('button', { class: 'cta full', onclick: () => go({ t: 'pair', prefill: '' }) }, 'Pair again'))];
  }

  let uiFor: Link | null | undefined;
  let uiCache: ControlUi | null = null;
  /** the remote-control screens over the real link (or the test harness's scripted api) */
  function ui(): ControlUi | null {
    if (opts.api) { uiCache ??= new ControlUi(opts.api, render); return uiCache; }
    if (!link) { uiCache = null; uiFor = null; return null; }
    if (uiFor !== link || !uiCache) { uiFor = link; uiCache = new ControlUi(fromLink(link, opts.transport ?? createProtocol3Transport(link)), render); }
    return uiCache;
  }

  /** a typing cursor must survive a redraw: the same text box, found again by its test id, gets focus and its selection back */
  function keepFocus(): (() => void) {
    const a = document.activeElement;
    if (!(a instanceof HTMLTextAreaElement) || !root!.contains(a)) return () => undefined;
    const id = a.getAttribute('data-testid'); const st = a.selectionStart; const en = a.selectionEnd; const top = a.scrollTop;
    return () => {
      const n = id ? root!.querySelector<HTMLTextAreaElement>(`textarea[data-testid="${id}"]`) : null;
      if (n && !n.disabled && document.activeElement !== n) { n.focus({ preventScroll: true }); try { n.setSelectionRange(st, en); } catch { /* not selectable */ } n.scrollTop = top; }
    };
  }

  function render(): void {
    if (unsupported) { mount(root!, ...[top(), h('div', { class: 'col page' }, h('div', { class: 'callout bad' }, 'This browser is too old. It cannot keep keys safely. Use a current Chrome, Safari or Firefox.'))]); return; }
    if (link?.revoked && screen.t !== 'gone' && screen.t !== 'pair') { link = null; screen = { t: 'gone', why: 'This phone was removed, or remote approvals were switched off for your account.' }; }
    resolveWant(); resolveRef();
    const restore = keepFocus();
    const u = ui();
    let nodes: HTMLElement[];
    switch (screen.t) {
      case 'pair': u?.syncWatch(null); nodes = pairView(screen); break;
      case 'sas': u?.syncWatch(null); nodes = sasView(screen); break;
      case 'home': nodes = u ? homeView(screen.sel ?? null) : pairView({ t: 'pair', prefill: '' }); break;
      case 'card': nodes = u ? (wide() ? homeView(screen.sid) : cardView(screen.sid)) : []; break;
      case 'devices': u?.syncWatch(null); nodes = link ? devicesView(link) : []; break;
      case 'gone': nodes = goneView(screen.why); break;
      case 'audit': u?.syncWatch(null); nodes = auditScreen(); break;
      case 'start': u?.syncWatch(null); nodes = startScreen(); break;
    }
    root!.classList.toggle('fixed', screen.t === 'card' && !wide() && !!u);
    root!.classList.toggle('split', wide() && (screen.t === 'home' || screen.t === 'card') && !!u);
    mount(root!, ...nodes, ...(u ? u.overlay() : []));
    restore();
    const waiting = u?.api.sessions().filter((x) => x.status === 'needs_you').length ?? 0;
    document.title = waiting ? `(${waiting}) Botwarren Link` : 'Botwarren Link';
    if (waiting === 0 && lastWaiting > 0) void clearShown(); // answered somewhere: the alert in the tray would only be stale
    lastWaiting = waiting;
  }

  function attach(l: Link): void { l.onChange(render); l.connect(); }
  function defaultName(): string { const ua = navigator.userAgent; return /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android phone' : 'Browser'; }

  window.addEventListener('hashchange', () => {
    if (screen.t === 'pair') { screen = { t: 'pair', prefill: codeFromHash() }; render(); return; }
    const rid = ridFromHash();
    const ref = OPEN_REF.exec(location.hash)?.[1];
    if (ref) wantRobot(ref); else if (rid) want(rid); else if (location.hash === '#/waiting') want(null);
  });
  // a tap on an alert while this page is already open arrives from the service worker
  try {
    navigator.serviceWorker?.addEventListener('message', (e: MessageEvent) => {
      const d = e.data as { t?: unknown; rid?: unknown } | null;
      if (d?.t === 'bw-open') want(typeof d.rid === 'string' && RID.test(d.rid) ? d.rid : null);
    });
  } catch { /* no service worker support: alerts are not offered either */ }
  setInterval(() => { if (screen.t === 'home' || screen.t === 'devices') render(); }, 30_000);
  // ages and "stale" verdicts on an open session are time-based
  setInterval(() => { if (screen.t === 'card' || (screen.t === 'home' && wide())) render(); }, 10_000);
  window.matchMedia?.('(min-width: 900px)').addEventListener?.('change', () => { render(); });
  if (link) attach(link);
  else if (opts.api) opts.api.onChange(render);
  if (opts.api && !opts.api.host().ready) { /* the harness sends its first state when it likes */ }
  render();
  if (wantRef !== null) wantRobot(wantRef);
  if (wantRid !== null) want(wantRid);
  if (location.hash === '#/waiting') want(null);
}
