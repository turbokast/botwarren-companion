import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { enable, STEP_MS, type AlertResult } from '../client/src/alerts.ts';
import type { Link } from '../client/src/link.ts';

/**
 * The owner's Android phone sat on "SETTING UP" for ever. Whatever the cause (here it was a computer whose Companion was never restarted after an update, so it
 * never answered), turning alerts on must END, with a result that names the step that stopped. This runs the page's real `enable()` against stand-ins for every
 * browser API, makes each step fail or hang in turn (with the time limits shortened), and checks the result.
 */
const SW_BYTES = Buffer.from('/* the worker */');
const PIN = { path: 'sw.js', sha256: createHash('sha256').update(SW_BYTES).digest('hex'), size: SW_BYTES.length };
const KEY = Buffer.alloc(65, 4).toString('base64url');
const ab = (n: number, fill: number): ArrayBuffer => new Uint8Array(n).fill(fill).buffer;
const never = <T>(): Promise<T> => new Promise<T>(() => undefined);
const domErr = (name: string): Error => Object.assign(new Error(name), { name });

interface Env {
  permission: 'granted' | 'denied' | 'default' | 'hang';
  keyFetch: 'ok' | '404' | 'throw' | 'hang';
  swFetch: 'ok' | 'bad' | '500';
  register: 'ok' | 'throw' | 'hang';
  ready: 'ok' | 'hang';
  subscribe: 'ok' | 'abort' | 'abort-once' | 'denied' | 'invalid' | 'hang';
  secure: boolean;
  api: boolean;
}
const base = (): Env => ({ permission: 'granted', keyFetch: 'ok', swFetch: 'ok', register: 'ok', ready: 'ok', subscribe: 'ok', secure: true, api: true });
const saved: Record<string, PropertyDescriptor | undefined> = {};
function define(name: string, value: unknown): void { saved[name] ??= Object.getOwnPropertyDescriptor(globalThis, name); Object.defineProperty(globalThis, name, { value, configurable: true, writable: true }); }

let subscribeCalls = 0;
function install(e: Env): void {
  subscribeCalls = 0;
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', options: { applicationServerKey: Buffer.from(KEY, 'base64url').buffer.slice(0) }, getKey: (n: string) => (n === 'p256dh' ? ab(65, 3) : ab(16, 2)), unsubscribe: async () => true };
  const reg = {
    pushManager: {
      getSubscription: async () => null,
      subscribe: async () => {
        subscribeCalls++;
        if (e.subscribe === 'hang') return never();
        if (e.subscribe === 'abort' || (e.subscribe === 'abort-once' && subscribeCalls === 1)) throw domErr('AbortError');
        if (e.subscribe === 'denied') throw domErr('NotAllowedError');
        if (e.subscribe === 'invalid') throw domErr('InvalidStateError');
        return sub;
      },
    },
  };
  define('window', e.api ? { isSecureContext: e.secure, PushManager: {}, Notification: {}, matchMedia: () => ({ matches: false }) } : { isSecureContext: e.secure });
  define('Notification', { permission: 'default', requestPermission: () => (e.permission === 'hang' ? never() : Promise.resolve(e.permission)) });
  define('navigator', {
    userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile', platform: 'Linux armv81', maxTouchPoints: 5,
    ...(e.api ? { serviceWorker: { register: () => (e.register === 'hang' ? never() : e.register === 'throw' ? Promise.reject(domErr('SecurityError')) : Promise.resolve(reg)), get ready() { return e.ready === 'hang' ? never() : Promise.resolve(reg); }, getRegistration: async () => reg } } : {}),
  });
  define('fetch', (url: string, init?: { signal?: AbortSignal }) => {
    if (url === '/v1/push/key') {
      if (e.keyFetch === 'throw') return Promise.reject(new TypeError('Failed to fetch'));
      if (e.keyFetch === 'hang') return new Promise((_ok, bad) => init?.signal?.addEventListener('abort', () => bad(domErr('AbortError'))));
      return Promise.resolve(e.keyFetch === '404' ? new Response('', { status: 404 }) : new Response(JSON.stringify({ key: KEY }), { status: 200 }));
    }
    if (url === 'sw.js') return Promise.resolve(e.swFetch === '500' ? new Response('', { status: 500 }) : new Response(e.swFetch === 'bad' ? Buffer.from('/* another worker */') : SW_BYTES, { status: 200 }));
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  });
}

interface Fake { sent: boolean; ack: { on: boolean; why?: string } | null; lacks: boolean; hostOnline: boolean | null; conn: string }
const link = (f: Partial<Fake> = {}): Link => {
  const x: Fake = { sent: true, ack: { on: true, why: 'ok' }, lacks: false, hostOnline: true, conn: 'online', ...f };
  return { setAlerts: async () => ({ sent: x.sent, ack: x.ack }), hostLacksAlerts: () => x.lacks, hostOnline: x.hostOnline, conn: x.conn } as unknown as Link;
};

const orig = { ...STEP_MS };
beforeEach(() => { for (const k of Object.keys(STEP_MS) as (keyof typeof STEP_MS)[]) STEP_MS[k] = 60; });
afterEach(() => { Object.assign(STEP_MS, orig); for (const [k, d] of Object.entries(saved)) { if (d) Object.defineProperty(globalThis, k, d); else delete (globalThis as Record<string, unknown>)[k]; } });

async function run(over: Partial<Env>, l: Link = link()): Promise<{ r: AlertResult; ms: number }> {
  install({ ...base(), ...over });
  const t0 = Date.now();
  const r = await enable(l, PIN);
  return { r, ms: Date.now() - t0 };
}

describe('turning alerts on always ends, and says which step stopped (the page\'s own enable())', () => {
  it('the happy path: the computer confirmed', async () => {
    expect((await run({})).r).toBe('ok');
    expect((await run({}, link({ ack: { on: true, why: 'host_off' } }))).r).toBe('ok_host_off');
  });

  it('not a secure page, no push support in this browser', async () => {
    expect((await run({ secure: false })).r).toBe('insecure');
    expect((await run({ api: false })).r).toBe('unsupported');
  });

  it('permission: denied, dismissed, and a question nobody answers (it ends, it does not hang)', async () => {
    expect((await run({ permission: 'denied' })).r).toBe('denied');
    expect((await run({ permission: 'default' })).r).toBe('dismissed');
    const x = await run({ permission: 'hang' });
    expect(x.r).toBe('prompt_timeout');
    expect(x.ms).toBeLessThan(1000);
  });

  it('the relay: no alerts configured (404), unreachable, and silent', async () => {
    expect((await run({ keyFetch: '404' })).r).toBe('unavailable');
    expect((await run({ keyFetch: 'throw' })).r).toBe('relay_unreachable');
    expect((await run({ keyFetch: 'hang' })).r).toBe('relay_unreachable');
  });

  it('the worker file: not what was signed, not downloadable, refused by the browser, never starting', async () => {
    expect((await run({ swFetch: 'bad' })).r).toBe('bad_worker');
    expect((await run({ swFetch: '500' })).r).toBe('worker_unreachable');
    expect((await run({ register: 'throw' })).r).toBe('worker_register');
    expect((await run({ register: 'hang' })).r).toBe('worker_timeout');
    expect((await run({ ready: 'hang' })).r).toBe('worker_timeout');
  });

  it('subscribing: the push service unreachable (retried once first), permission withdrawn, an odd failure, and a hang', async () => {
    const a = await run({ subscribe: 'abort' });
    expect(a.r).toBe('push_service');
    expect(subscribeCalls).toBe(2); // the first AbortError is retried from a clean slate
    expect((await run({ subscribe: 'abort-once' })).r).toBe('ok'); // and the retry can succeed
    expect((await run({ subscribe: 'denied' })).r).toBe('subscribe_denied');
    expect((await run({ subscribe: 'invalid' })).r).toBe('subscribe_failed');
    expect((await run({ subscribe: 'hang' })).r).toBe('subscribe_timeout');
  });

  it('the computer: unreachable, an older Companion that never answers, silent, rejecting', async () => {
    expect((await run({}, link({ sent: false, ack: null }))).r).toBe('waiting_computer'); // not connected: kept, sent again when connected
    expect((await run({}, link({ ack: null, lacks: true }))).r).toBe('host_old'); // online, sent state, never answered: older than 0.1.2
    expect((await run({}, link({ ack: null, hostOnline: false }))).r).toBe('waiting_computer');
    expect((await run({}, link({ ack: null }))).r).toBe('host_silent');
    expect((await run({}, link({ ack: { on: false, why: 'rejected' } }))).r).toBe('host_rejected');
  });

  it('no step can take longer than its limit: every failing run above ended within a fraction of a second', async () => {
    for (const over of [{ permission: 'hang' }, { keyFetch: 'hang' }, { register: 'hang' }, { ready: 'hang' }, { subscribe: 'hang' }] as Partial<Env>[]) {
      const { ms } = await run(over);
      expect(ms, JSON.stringify(over)).toBeLessThan(1500);
    }
  });
});
