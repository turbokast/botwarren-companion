/**
 * The verified bootstrap loader of the Botwarren Companion web client (Apache-2.0).
 *
 * index.html loads ONLY this file (with a Subresource Integrity hash). It then:
 *   1. fetches manifest.json and manifest.json.sig,
 *   2. verifies the Ed25519 signature (domain "botwarren-client-v1\0") against the PINNED release public keys below,
 *   3. checks the manifest has not expired,
 *   4. fetches every listed file, checks its size and SHA-256 against the signed manifest, and keeps the verified bytes,
 *   5. starts the app from those bytes (blob: URLs), never from a second fetch of the same file.
 * If anything is wrong it shows why and runs nothing.
 *
 * Honest limit: this file is itself served by the same origin, so it protects against a tampered CDN, object store, cache or partial
 * deploy, not against the origin serving a different loader. See docs/CLIENT_SECURITY.md.
 */
declare const __PINNED_KEYS__: { id: string; spki: string }[];

const DOMAIN = 'botwarren-client-v1\0';
const enc = new TextEncoder();

interface Entry { path: string; sha256: string; size: number; type: string }
interface Manifest { schema: 1; kind: 'botwarren-companion-client'; version: string; build: string; issued: string; expires: string; entry: { js: Entry; css: Entry } }

const b64 = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const hex = (b: ArrayBuffer): string => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const get = async (p: string): Promise<ArrayBuffer> => {
  const r = await fetch(p, { cache: 'no-store', credentials: 'omit', redirect: 'error' });
  if (!r.ok) throw new Error(`could not load ${p}`);
  return r.arrayBuffer();
};

function fail(why: string): void {
  const boot = document.getElementById('boot');
  const box = boot ?? document.body;
  box.textContent = '';
  const h = document.createElement('h1'); h.textContent = 'This page did not start'; box.appendChild(h);
  const p = document.createElement('p'); p.textContent = why; box.appendChild(p);
  const q = document.createElement('p'); q.textContent = 'Do not use this page. Nothing was run. Tell support@turbokast.com.'; box.appendChild(q);
}

async function verified(): Promise<{ m: Manifest; keyId: string; js: Uint8Array; css: Uint8Array }> {
  if (!globalThis.crypto?.subtle) throw new Error('this browser cannot verify signatures (it needs a recent Chrome, Safari or Firefox)');
  const mBytes = new Uint8Array(await get('manifest.json'));
  const sigFile = JSON.parse(new TextDecoder().decode(await get('manifest.json.sig'))) as { alg?: string; keyId?: string; sig?: string };
  if (sigFile.alg !== 'ed25519' || typeof sigFile.keyId !== 'string' || typeof sigFile.sig !== 'string') throw new Error('the signature file is malformed');
  const pinned = __PINNED_KEYS__.find((k) => k.id === sigFile.keyId);
  if (!pinned) throw new Error(`the page is signed with a key this loader does not trust (${sigFile.keyId})`);
  let ok = false;
  try {
    const key = await crypto.subtle.importKey('spki', b64(pinned.spki), 'Ed25519', false, ['verify']);
    const msg = new Uint8Array([...enc.encode(DOMAIN), ...mBytes]);
    ok = await crypto.subtle.verify('Ed25519', key, b64(sigFile.sig), msg);
  } catch { throw new Error('this browser cannot check Ed25519 signatures (update it)'); }
  if (!ok) throw new Error('the signature does not match the page');
  const m = JSON.parse(new TextDecoder().decode(mBytes)) as Manifest;
  if (m.schema !== 1 || m.kind !== 'botwarren-companion-client') throw new Error('unexpected manifest');
  if (Date.parse(m.expires) <= Date.now()) throw new Error('this build has expired; reload to get the current one');
  const fetchChecked = async (e: Entry): Promise<Uint8Array> => {
    if (!/^[A-Za-z0-9._-]+$/.test(e.path)) throw new Error('bad file name in manifest');
    const buf = await get(e.path);
    if (buf.byteLength !== e.size) throw new Error(`${e.path} has the wrong size`);
    if (hex(await crypto.subtle.digest('SHA-256', buf)) !== e.sha256) throw new Error(`${e.path} does not match the signed hash`);
    return new Uint8Array(buf);
  };
  const [js, css] = await Promise.all([fetchChecked(m.entry.js), fetchChecked(m.entry.css)]);
  return { m, keyId: sigFile.keyId, js, css };
}

async function boot(): Promise<void> {
  try {
    const { m, keyId, js, css } = await verified();
    const cssUrl = URL.createObjectURL(new Blob([css as BlobPart], { type: 'text/css' }));
    const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = cssUrl; document.head.appendChild(link);
    const jsUrl = URL.createObjectURL(new Blob([js as BlobPart], { type: 'text/javascript' }));
    const mod = (await import(/* @vite-ignore */ jsUrl)) as { start: (info: { build: string; version: string; keyId: string; expires: string }) => void };
    mod.start({ build: m.build, version: m.version, keyId, expires: m.expires });
  } catch (e) { fail((e as Error).message); }
}

void boot();
