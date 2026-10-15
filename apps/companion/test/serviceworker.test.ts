import { describe, expect, it } from 'vitest';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
// @ts-expect-error plain JS modules without types
import { buildClient } from '../client/scripts/lib.mjs';

const swPath = fileURLToPath(new URL('../client/static/sw.js', import.meta.url));
const source = readFileSync(swPath, 'utf8');

const CHROME = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
const SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

interface Win { visibilityState: string; focus?: () => Promise<void>; postMessage: (m: unknown) => void }

/** the service worker file run against a stand-in for its global scope */
function load(ua = CHROME, windows: Win[] = []) {
  const listeners: Record<string, (e: unknown) => void> = {};
  const shown: { title: string; opts: Record<string, unknown> }[] = [];
  const opened: string[] = [];
  const self = {
    addEventListener: (t: string, f: (e: unknown) => void) => { listeners[t] = f; },
    skipWaiting: () => undefined,
    clients: { claim: async () => undefined, matchAll: async () => windows, openWindow: async (u: string) => { opened.push(u); } },
    registration: { showNotification: async (title: string, opts: Record<string, unknown>) => { shown.push({ title, opts }); } },
    navigator: { userAgent: ua },
  };
  runInNewContext(source, { self });
  const fire = async (type: string, e: Record<string, unknown>): Promise<void> => { let p: Promise<unknown> = Promise.resolve(); listeners[type]!({ ...e, waitUntil: (x: Promise<unknown>) => { p = x; } }); await p; };
  const push = (data: unknown): Promise<void> => fire('push', { data: data === undefined ? null : { json: () => { if (data === 'not json') throw new SyntaxError('x'); return data; } } });
  return { listeners, shown, opened, fire, push };
}

describe('the alert service worker (client/static/sw.js)', () => {
  it('has only install, activate, push and notificationclick handlers: no handler for network requests, so it can never sit between the page and the network', () => {
    const { listeners } = load();
    expect(Object.keys(listeners).sort()).toEqual(['activate', 'install', 'notificationclick', 'push']);
    expect(source).not.toMatch(/\bfetch\b/);
    expect(source).not.toMatch(/importScripts|XMLHttpRequest|WebSocket|caches\b/);
  });

  it('shows ONE notification with fixed words; the request id only rides along as data for the tap', async () => {
    const sw = load();
    await sw.push({ v: 1, k: 'waiting', r: 'abcd-123456' });
    expect(sw.shown).toEqual([{ title: 'Botwarren', opts: { body: 'An agent is waiting for you', tag: 'bw-waiting', renotify: true, data: { rid: 'abcd-123456' } } }]);
  });

  it('shows the same fixed words whatever the payload says: forged text, markup, a path-like id, garbage, or nothing at all', async () => {
    for (const payload of [
      { v: 1, k: 'waiting', title: 'Your account is hacked', body: 'Click here', r: 'abcd-123456' },
      { v: 1, k: 'waiting', r: '../../evil' }, { v: 1, k: 'waiting', r: '<img src=x onerror=alert(1)>' }, { v: 2, k: 'waiting', r: 'abcd-123456' }, { v: 1, k: 'other' }, 'not json', undefined, null, 5,
    ]) {
      const sw = load();
      await sw.push(payload);
      expect(sw.shown, JSON.stringify(payload)).toHaveLength(1);
      const n = sw.shown[0]!;
      expect(n.title).toBe('Botwarren');
      expect(n.opts.body).toBe('An agent is waiting for you');
      expect(Object.keys(n.opts).sort()).toEqual(['body', 'data', 'renotify', 'tag']);
      const text = JSON.stringify(n);
      for (const leak of ['hacked', 'Click', 'evil', 'onerror', 'img']) expect(text).not.toContain(leak);
    }
  });

  it('while the page is open and visible the page shows the request itself, except where the browser insists on a notification (Safari, macOS and iOS)', async () => {
    const msgs: unknown[] = [];
    const visible: Win = { visibilityState: 'visible', postMessage: (m) => { msgs.push(m); } };
    const chrome = load(CHROME, [visible]);
    await chrome.push({ v: 1, k: 'waiting', r: 'abcd-123456' });
    expect(chrome.shown).toHaveLength(0);
    expect(msgs).toEqual([{ t: 'bw-waiting', rid: 'abcd-123456' }]);
    const safari = load(SAFARI, [visible]);
    await safari.push({ v: 1, k: 'waiting', r: 'abcd-123456' });
    expect(safari.shown).toHaveLength(1);
    const hidden = load(CHROME, [{ visibilityState: 'hidden', postMessage: () => undefined }]);
    await hidden.push({ v: 1, k: 'waiting' });
    expect(hidden.shown).toHaveLength(1);
  });

  it('a tap focuses the open page and tells it which request, or opens the page on that request (a relative URL of its own origin), or on the list when the id is not one of ours', async () => {
    const msgs: unknown[] = []; let focused = 0;
    const open: Win = { visibilityState: 'hidden', focus: async () => { focused++; }, postMessage: (m) => { msgs.push(m); } };
    const a = load(CHROME, [open]);
    await a.fire('notificationclick', { notification: { close: () => undefined, data: { rid: 'abcd-123456' } } });
    expect(focused).toBe(1);
    expect(msgs).toEqual([{ t: 'bw-open', rid: 'abcd-123456' }]);
    expect(a.opened).toEqual([]);

    const b = load(); await b.fire('notificationclick', { notification: { close: () => undefined, data: { rid: 'abcd-123456' } } });
    expect(b.opened).toEqual(['./#/r/abcd-123456']);
    for (const data of [{ rid: 'https://evil.example/' }, { rid: '../x' }, {}, null, undefined]) {
      const c = load(); await c.fire('notificationclick', { notification: { close: () => undefined, data } });
      expect(c.opened, JSON.stringify(data)).toEqual(['./#/waiting']);
    }
  });
});

describe('the worker is pinned by the signed manifest', () => {
  it('buildClient lists sw.js with its SHA-256 and size', async () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    const keys = [{ id: 'test-1', spki: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }];
    const dir = mkdtempSync(join(tmpdir(), 'bw-sw-'));
    const { manifest, out } = await buildClient({ outDir: dir, keys, version: '0.0.0-test', now: 1_800_000_000_000 });
    const served = readFileSync(join(out, 'sw.js'));
    expect(manifest.sw).toEqual({ path: 'sw.js', sha256: createHash('sha256').update(served).digest('hex'), size: served.length });
    expect(served.equals(readFileSync(swPath))).toBe(true);
    expect(manifest.sw.path).toMatch(/^[A-Za-z0-9._-]+$/); // what the loader accepts
  });
});
