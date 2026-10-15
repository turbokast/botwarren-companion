/**
 * Phone alerts, device side. This phone's page asks the browser for its OWN Web Push subscription and hands it to your computer inside the end-to-end
 * encrypted channel (never to the relay or botwarren.com). Your computer seals each alert for those keys, so what crosses the relay and the push
 * service is ciphertext that says nothing; the words the person reads ("An agent is waiting for you") are fixed in sw.js.
 *
 * Browser rules this code keeps to: the permission prompt is the FIRST await inside the tap (iOS ties it to the tap); on iPhone and iPad Web Push exists
 * only for a site added to the Home Screen; the service worker is registered only after its bytes were checked against the signed manifest.
 */
import type { Link } from './link.ts';
import { b64u, unb64u } from '../../src/protocol/index.ts';

export type Support = 'ok' | 'ios-install' | 'unsupported';
export type AlertResult = 'ok' | 'denied' | 'dismissed' | 'unavailable' | 'bad_worker' | 'failed' | 'unsupported';

const FLAG = 'bw-alerts';
export interface SwPin { path: string; sha256: string; size: number }

const hasApi = (): boolean => typeof navigator !== 'undefined' && 'serviceWorker' in navigator && typeof window !== 'undefined' && 'PushManager' in window && 'Notification' in window;
export const isIos = (): boolean => typeof navigator !== 'undefined' && (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));
export const isStandalone = (): boolean => typeof window !== 'undefined' && (window.matchMedia?.('(display-mode: standalone)').matches === true || (navigator as unknown as { standalone?: boolean }).standalone === true);

/** `ios-install`: an iPhone or iPad whose browser offers no Web Push until the page is on the Home Screen */
export function detectSupport(): Support {
  if (hasApi()) return 'ok';
  return isIos() && !isStandalone() ? 'ios-install' : 'unsupported';
}

export const permission = (): NotificationPermission | 'unsupported' => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);

/** this browser's own memory that the person turned alerts on (so the page can re-send its subscription when it connects); never required to render */
export function wantsAlerts(): boolean { try { return localStorage.getItem(FLAG) === '1'; } catch { return false; } }
function remember(on: boolean): void { try { if (on) localStorage.setItem(FLAG, '1'); else localStorage.removeItem(FLAG); } catch { /* private window: the toggle still works for this visit */ } }

/** the relay's public application server key, or null when this relay does not send alerts */
async function relayKey(): Promise<Uint8Array | null> {
  try {
    const r = await fetch('/v1/push/key', { credentials: 'omit', cache: 'no-store' });
    if (!r.ok) return null;
    const j = (await r.json()) as { key?: unknown };
    return typeof j.key === 'string' && /^[A-Za-z0-9_-]{80,100}$/.test(j.key) ? unb64u(j.key) : null;
  } catch { return null; }
}

async function sha256Hex(buf: ArrayBuffer): Promise<string> { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map((x) => x.toString(16).padStart(2, '0')).join(''); }

/** the worker's bytes must be exactly what the signed manifest lists, or nothing is registered */
export async function workerMatchesManifest(pin: SwPin | undefined): Promise<boolean> {
  if (!pin || !/^[A-Za-z0-9._-]+$/.test(pin.path)) return false;
  try {
    const r = await fetch(pin.path, { cache: 'no-store', credentials: 'omit', redirect: 'error' });
    if (!r.ok) return false;
    const buf = await r.arrayBuffer();
    return buf.byteLength === pin.size && (await sha256Hex(buf)) === pin.sha256;
  } catch { return false; }
}

const same = (a: ArrayBuffer | null | undefined, b: Uint8Array): boolean => !!a && new Uint8Array(a).length === b.length && new Uint8Array(a).every((x, i) => x === b[i]);

export async function registration(): Promise<ServiceWorkerRegistration | undefined> {
  try { return await navigator.serviceWorker.getRegistration(); } catch { return undefined; }
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

/** Turns alerts on for this phone. Call straight from a tap. */
export async function enable(link: Link, pin: SwPin | undefined): Promise<AlertResult> {
  if (!hasApi()) return 'unsupported';
  let perm: NotificationPermission;
  try { perm = await Notification.requestPermission(); } catch { return 'failed'; } // the first await: iOS needs it inside the tap
  if (perm === 'denied') return 'denied';
  if (perm !== 'granted') return 'dismissed';
  const key = await relayKey();
  if (!key) return 'unavailable';
  if (!(await workerMatchesManifest(pin))) return 'bad_worker';
  try {
    const reg = await navigator.serviceWorker.register(pin!.path, { scope: './', updateViaCache: 'none' });
    await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (sub && !same(sub.options.applicationServerKey, key)) { await sub.unsubscribe().catch(() => undefined); sub = null; } // made for another relay key
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key as BufferSource });
    const s = shape(sub);
    if (!s) return 'failed';
    remember(true);
    await link.setAlerts(s);
    return 'ok';
  } catch { return 'failed'; }
}

/** Turns alerts off: the computer forgets this phone's subscription and the browser drops it */
export async function disable(link: Link): Promise<void> {
  remember(false);
  await link.setAlerts(null).catch(() => undefined);
  try { await (await (await registration())?.pushManager.getSubscription())?.unsubscribe(); } catch { /* the computer no longer has it either way */ }
}

/** closes a shown alert whose request was handled, so the notification tray does not keep a stale "waiting" */
export async function clearShown(): Promise<void> {
  try { for (const n of (await (await registration())?.getNotifications({ tag: 'bw-waiting' })) ?? []) n.close(); } catch { /* none */ }
}
