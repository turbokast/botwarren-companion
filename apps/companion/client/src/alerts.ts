/**
 * Phone alerts, device side. This phone's page asks the browser for its OWN Web Push subscription and hands it to your computer inside the end-to-end
 * encrypted channel (never to the relay or botwarren.com). Your computer seals each alert for those keys, so what crosses the relay and the push
 * service is ciphertext that says nothing; the words the person reads ("An agent is waiting for you") are fixed in sw.js.
 *
 * Browser rules this code keeps to: the permission prompt is the FIRST await inside the tap (iOS ties it to the tap); on iPhone and iPad Web Push exists
 * only for a site added to the Home Screen; the service worker is registered only after its bytes were checked against the signed manifest.
 *
 * No step waits without a limit (0.1.3): the owner's Android phone sat on "setting up" for ever when the computer never answered. Every awaited step has a
 * time limit and its own result code, and app.ts has plain words for each.
 */
import type { Link } from './link.ts';
import { b64u, unb64u } from '../../src/protocol/index.ts';

export type Support = 'ok' | 'ios-install' | 'unsupported' | 'insecure';

/**
 * Every way turning alerts on can end.
 *   ok / ok_host_off   the computer confirmed it holds this phone's subscription (host_off: but its own master switch for alerts is off)
 *   waiting_computer   the subscription is made and kept here, but the computer cannot be reached right now; it is sent again when the page connects
 *   host_old           the computer is reachable but never answers the alerts question: its Companion is older than 0.1.2 (or was not restarted after an update)
 *   host_silent        the computer is reachable and not known to be old, but did not answer in time
 *   host_rejected      the computer refused the subscription (it did not pass its checks)
 */
export type AlertResult =
  | 'ok' | 'ok_host_off' | 'waiting_computer' | 'host_old' | 'host_silent' | 'host_rejected'
  | 'denied' | 'dismissed' | 'prompt_timeout' | 'relay_unreachable' | 'unavailable' | 'bad_worker' | 'worker_unreachable' | 'worker_register' | 'worker_timeout'
  | 'push_service' | 'subscribe_denied' | 'subscribe_timeout' | 'subscribe_failed' | 'no_keys' | 'failed' | 'unsupported' | 'insecure';

/** how long each awaited step may take before the person is told which one stalled */
export const STEP_MS = { permission: 90_000, relayKey: 8_000, worker: 8_000, register: 12_000, ready: 12_000, subscribe: 25_000, host: 12_000 };

class StepTimeout extends Error { readonly step: string; constructor(step: string) { super(`${step} timed out`); this.step = step; } }
function within<T>(p: Promise<T>, ms: number, step: string): Promise<T> {
  return new Promise<T>((ok, bad) => { const t = setTimeout(() => bad(new StepTimeout(step)), ms); p.then((v) => { clearTimeout(t); ok(v); }, (e) => { clearTimeout(t); bad(e); }); });
}
const errName = (e: unknown): string => (e && typeof e === 'object' && 'name' in e ? String((e as { name: unknown }).name) : '');

const FLAG = 'bw-alerts';
export interface SwPin { path: string; sha256: string; size: number }

const hasApi = (): boolean => typeof navigator !== 'undefined' && 'serviceWorker' in navigator && typeof window !== 'undefined' && 'PushManager' in window && 'Notification' in window;
export const isIos = (): boolean => typeof navigator !== 'undefined' && (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));
export const isStandalone = (): boolean => typeof window !== 'undefined' && (window.matchMedia?.('(display-mode: standalone)').matches === true || (navigator as unknown as { standalone?: boolean }).standalone === true);

/** `ios-install`: an iPhone or iPad whose browser offers no Web Push until the page is on the Home Screen; `insecure`: not an https page (no service workers there) */
export function detectSupport(): Support {
  if (typeof window !== 'undefined' && window.isSecureContext === false) return 'insecure';
  if (hasApi()) return 'ok';
  return isIos() && !isStandalone() ? 'ios-install' : 'unsupported';
}

export const permission = (): NotificationPermission | 'unsupported' => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);

/** this browser's own memory that the person turned alerts on (so the page can re-send its subscription when it connects); never required to render */
export function wantsAlerts(): boolean { try { return localStorage.getItem(FLAG) === '1'; } catch { return false; } }
function remember(on: boolean): void { try { if (on) localStorage.setItem(FLAG, '1'); else localStorage.removeItem(FLAG); } catch { /* private window: the toggle still works for this visit */ } }

/** the relay's public application server key; `unreachable` when the request itself failed, `off` when this relay does not send alerts */
async function relayKey(): Promise<{ key: Uint8Array } | { err: 'unreachable' | 'off' }> {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), STEP_MS.relayKey);
  try {
    const r = await fetch('/v1/push/key', { credentials: 'omit', cache: 'no-store', signal: ctl.signal });
    if (r.status === 404) return { err: 'off' };
    if (!r.ok) return { err: 'unreachable' };
    const j = (await r.json()) as { key?: unknown };
    return typeof j.key === 'string' && /^[A-Za-z0-9_-]{80,100}$/.test(j.key) ? { key: unb64u(j.key) } : { err: 'off' };
  } catch { return { err: 'unreachable' }; } finally { clearTimeout(t); }
}

async function sha256Hex(buf: ArrayBuffer): Promise<string> { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map((x) => x.toString(16).padStart(2, '0')).join(''); }

/** the worker's bytes must be exactly what the signed manifest lists, or nothing is registered. `unreachable`: it could not be fetched; `mismatch`: fetched but not what was signed */
export async function checkWorker(pin: SwPin | undefined): Promise<'ok' | 'unreachable' | 'mismatch'> {
  if (!pin || !/^[A-Za-z0-9._-]+$/.test(pin.path)) return 'mismatch';
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), STEP_MS.worker);
  try {
    const r = await fetch(pin.path, { cache: 'no-store', credentials: 'omit', redirect: 'error', signal: ctl.signal });
    if (!r.ok) return 'unreachable';
    const buf = await r.arrayBuffer();
    return buf.byteLength === pin.size && (await sha256Hex(buf)) === pin.sha256 ? 'ok' : 'mismatch';
  } catch { return 'unreachable'; } finally { clearTimeout(t); }
}
export async function workerMatchesManifest(pin: SwPin | undefined): Promise<boolean> { return (await checkWorker(pin)) === 'ok'; }

const same = (a: ArrayBuffer | null | undefined, b: Uint8Array): boolean => !!a && new Uint8Array(a).length === b.length && new Uint8Array(a).every((x, i) => x === b[i]);

export async function registration(): Promise<ServiceWorkerRegistration | undefined> {
  try { return await within(navigator.serviceWorker.getRegistration(), 5000, 'registration'); } catch { return undefined; }
}

/** this phone's subscription as the host needs it, or null */
export async function currentSubscription(): Promise<{ endpoint: string; p256dh: string; auth: string } | null> {
  if (!hasApi()) return null;
  try {
    const sub = await (await registration())?.pushManager.getSubscription();
    return sub ? shape(sub) : null;
  } catch { return null; }
}

function shape(sub: PushSubscription): { endpoint: string; p256dh: string; auth: string } | null {
  const p = sub.getKey('p256dh'); const a = sub.getKey('auth');
  return p && a ? { endpoint: sub.endpoint, p256dh: b64u(new Uint8Array(p)), auth: b64u(new Uint8Array(a)) } : null;
}

/** Turns alerts on for this phone. Call straight from a tap. Never waits without a limit; the result says which step stopped. */
export async function enable(link: Link, pin: SwPin | undefined): Promise<AlertResult> {
  if (typeof window !== 'undefined' && window.isSecureContext === false) return 'insecure';
  if (!hasApi()) return 'unsupported';
  let perm: NotificationPermission;
  // the first await inside the tap: iOS ties the permission prompt to it
  try { perm = await within(Notification.requestPermission(), STEP_MS.permission, 'permission'); } catch (e) { return e instanceof StepTimeout ? 'prompt_timeout' : 'failed'; }
  if (perm === 'denied') return 'denied';
  if (perm !== 'granted') return 'dismissed';
  const k = await relayKey();
  if ('err' in k) return k.err === 'off' ? 'unavailable' : 'relay_unreachable';
  const w = await checkWorker(pin);
  if (w === 'unreachable') return 'worker_unreachable';
  if (w !== 'ok') return 'bad_worker';
  let reg: ServiceWorkerRegistration;
  try { reg = await within(navigator.serviceWorker.register(pin!.path, { scope: './', updateViaCache: 'none' }), STEP_MS.register, 'register'); } catch (e) { return e instanceof StepTimeout ? 'worker_timeout' : 'worker_register'; }
  try { await within(navigator.serviceWorker.ready, STEP_MS.ready, 'ready'); } catch { return 'worker_timeout'; }
  let sub: PushSubscription;
  try {
    const subscribe = async (): Promise<PushSubscription> => {
      let cur = await reg.pushManager.getSubscription();
      if (cur && !same(cur.options.applicationServerKey, k.key)) { await cur.unsubscribe().catch(() => undefined); cur = null; } // made for another relay key
      return cur ?? reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: k.key as BufferSource });
    };
    try { sub = await within(subscribe(), STEP_MS.subscribe, 'subscribe'); } catch (e) {
      // Android Chrome sometimes fails the first subscribe while its push service connection wakes up: once more, from a clean slate
      if (e instanceof StepTimeout || errName(e) !== 'AbortError') throw e;
      await (await reg.pushManager.getSubscription())?.unsubscribe().catch(() => undefined);
      sub = await within(subscribe(), STEP_MS.subscribe, 'subscribe');
    }
  } catch (e) {
    if (e instanceof StepTimeout) return 'subscribe_timeout';
    const n = errName(e);
    return n === 'AbortError' || n === 'NetworkError' ? 'push_service' : n === 'NotAllowedError' ? 'subscribe_denied' : 'subscribe_failed';
  }
  const s = shape(sub);
  if (!s) return 'no_keys';
  remember(true); // from here the page keeps sending the subscription whenever it connects
  const r = await link.setAlerts(s, STEP_MS.host);
  if (!r.sent) return 'waiting_computer';
  if (!r.ack) return link.hostLacksAlerts(0) ? 'host_old' : link.hostOnline === false || link.conn !== 'online' ? 'waiting_computer' : 'host_silent';
  if (r.ack.why === 'rejected') return 'host_rejected';
  return r.ack.on ? (r.ack.why === 'host_off' ? 'ok_host_off' : 'ok') : 'failed';
}

export type TestResult =
  | 'arrived' | 'not_arrived' | 'no_reply' | 'no_subscription' | 'no_permission' | 'alerts_off' | 'rate_limited' | 'relay_off' | 'relay_busy' | 'bad_endpoint'
  | 'push_gone' | 'push_refused' | 'not_sent' | 'offline' | 'unsupported';

/** the page hears a test alert that came through the push service (the worker tells it) */
const arrivals = new Map<string, () => void>();
let arrivalListener = false;
function listenForArrivals(): void {
  if (arrivalListener) return;
  arrivalListener = true;
  try { navigator.serviceWorker.addEventListener('message', (e: MessageEvent) => { const d = e.data as { t?: unknown; n?: unknown } | null; if (d?.t === 'bw-test' && typeof d.n === 'string') arrivals.get(d.n)?.(); }); } catch { /* no worker support */ }
}
const waitArrival = (n: string, ms: number): Promise<boolean> => new Promise((ok) => { const t = setTimeout(() => { arrivals.delete(n); ok(false); }, ms); arrivals.set(n, () => { clearTimeout(t); arrivals.delete(n); ok(true); }); });

/**
 * "Send a test alert": phone to computer to relay to push service and back to this phone. `onStep` hears each leg as it is confirmed. A leg that does not
 * confirm in time ends the test and says which one.
 */
export async function sendTest(link: Link, onStep: (s: 'asked' | 'computer' | 'pushed') => void): Promise<TestResult> {
  if (!hasApi()) return 'unsupported';
  if (permission() !== 'granted') return 'no_permission';
  if (link.conn !== 'online') return 'offline';
  if (!(await currentSubscription())) return 'no_subscription';
  listenForArrivals();
  const n = b64u(crypto.getRandomValues(new Uint8Array(12)));
  const arrived = waitArrival(n, 30_000); // armed before asking: the alert can beat the computer's own answer
  onStep('asked');
  const last = await link.sendTestAlert(n, (a) => { if (a.stage === 'received') onStep('computer'); else if (a.stage === 'pushed') onStep('pushed'); }, 15_000);
  if (!last) { arrivals.delete(n); return 'no_reply'; }
  if (last.stage === 'failed') { arrivals.delete(n); return (last.why ?? 'not_sent') as TestResult; }
  if (last.stage === 'received') { arrivals.delete(n); return 'no_reply'; } // it got the request and never reported the hand-over
  return (await Promise.race([arrived, new Promise<boolean>((ok) => setTimeout(() => ok(false), 15_000))])) ? 'arrived' : 'not_arrived';
}

/** Turns alerts off: the computer forgets this phone's subscription and the browser drops it */
export async function disable(link: Link): Promise<void> {
  remember(false);
  await link.setAlerts(null, 4000).catch(() => undefined);
  try { await (await (await registration())?.pushManager.getSubscription())?.unsubscribe(); } catch { /* the computer no longer has it either way */ }
}

/** closes a shown alert whose request was handled, so the notification tray does not keep a stale "waiting" */
export async function clearShown(): Promise<void> {
  try { for (const n of (await (await registration())?.getNotifications({ tag: 'bw-waiting' })) ?? []) n.close(); } catch { /* none */ }
}
