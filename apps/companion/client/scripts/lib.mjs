/**
 * Build and sign the Companion web client. Reproducible: the same source, esbuild version and SOURCE_DATE_EPOCH give the same bytes.
 * Licence: Apache-2.0.
 */
import { createHash, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const clientRoot = resolve(here, '..');
export const SIGNATURE_DOMAIN = Buffer.from('botwarren-client-v1\0', 'utf8');
const sha = (b) => createHash('sha256').update(b).digest('hex');

/**
 * The pinned COMPONENT signing keys (ship agent src/update/keys.ts COMPONENT_PUBLIC_KEYS): the key that signs this repository's web client and its
 * installable component. It is NOT the key that signs the ship agent's updates (a separate Cloud KMS key and service account); the loader pins this one.
 * Dev keys only when asked.
 */
export async function releaseKeys({ allowDev = false, extra = [], keysModule = resolve(here, '../../vendor/agent/src/update/keys.ts') } = {}) {
  const { COMPONENT_PUBLIC_KEYS, roleOf } = await import(keysModule);
  const keys = COMPONENT_PUBLIC_KEYS.filter((k) => roleOf(k) === 'component' && (allowDev || !k.dev)).map((k) => ({ id: k.id, spki: k.spki }));
  return [...keys, ...extra];
}

/** ids of pinned component keys whose public key is still the PLACEHOLDER (nothing may be signed with them) */
export async function placeholderKeyIds({ keysModule = resolve(here, '../../vendor/agent/src/update/keys.ts') } = {}) {
  const { COMPONENT_PUBLIC_KEYS } = await import(keysModule);
  return COMPONENT_PUBLIC_KEYS.filter((k) => k.placeholder === true).map((k) => k.id);
}

export async function buildClient({ outDir, keys, version, commit = '', now = Date.now(), validDays = 400 }) {
  // esbuild is a development dependency: imported here, not at the top, so the signing and verification scripts (which also import this file) run with production dependencies only
  const { build } = await import('esbuild');
  const out = resolve(outDir);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const common = { bundle: true, minify: true, target: 'es2022', platform: 'browser', legalComments: 'none', write: false, logLevel: 'silent', sourcemap: false };
  const app = (await build({ ...common, entryPoints: [join(clientRoot, 'src/app.ts')], format: 'esm' })).outputFiles[0].contents;
  const loader = (await build({ ...common, entryPoints: [join(clientRoot, 'src/loader.ts')], format: 'iife', define: { __PINNED_KEYS__: JSON.stringify(keys) } })).outputFiles[0].contents;
  const css = readFileSync(join(clientRoot, 'app.css'));
  const jsHash = sha(app); const cssHash = sha(css); const loaderHash = sha(loader);
  const jsName = `app.${jsHash.slice(0, 12)}.js`; const cssName = `app.${cssHash.slice(0, 12)}.css`;
  writeFileSync(join(out, jsName), app); writeFileSync(join(out, cssName), css); writeFileSync(join(out, 'loader.js'), loader);
  const sri = `sha256-${createHash('sha256').update(loader).digest('base64')}`;
  writeFileSync(join(out, 'index.html'), readFileSync(join(clientRoot, 'index.html'), 'utf8').replace('__LOADER_SRI__', sri));
  cpSync(join(clientRoot, 'static'), out, { recursive: true });
  const manifest = {
    schema: 1, kind: 'botwarren-companion-client', version, build: sha(`${jsHash}${cssHash}${loaderHash}`).slice(0, 12),
    issued: new Date(now).toISOString(), expires: new Date(now + validDays * 86_400_000).toISOString(), ...(commit ? { commit } : {}),
    entry: { js: { path: jsName, sha256: jsHash, size: app.length, type: 'text/javascript' }, css: { path: cssName, sha256: cssHash, size: css.length, type: 'text/css' } },
    loader: { path: 'loader.js', sha256: loaderHash, size: loader.length },
  };
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { out, manifest, loaderSri: sri };
}

/** bytes signed = domain || exact manifest bytes; the signature file is {alg, keyId, sig(base64)} */
export function signBytes(bytes, privateKeyPem, keyId) {
  const sig = edSign(null, Buffer.concat([SIGNATURE_DOMAIN, bytes]), createPrivateKey(privateKeyPem)).toString('base64');
  return JSON.stringify({ alg: 'ed25519', keyId, sig }) + '\n';
}

export function verifySig(bytes, sigText, keys) {
  const s = JSON.parse(sigText);
  const k = keys.find((x) => x.id === s.keyId);
  if (!k) return false;
  return edVerify(null, Buffer.concat([SIGNATURE_DOMAIN, bytes]), createPublicKey({ key: Buffer.from(k.spki, 'base64'), format: 'der', type: 'spki' }), Buffer.from(s.sig, 'base64'));
}

export function signClient({ outDir, privateKeyPem, keyId, keys }) {
  const file = join(resolve(outDir), 'manifest.json');
  const bytes = readFileSync(file);
  const sigText = signBytes(bytes, privateKeyPem, keyId);
  if (!verifySig(bytes, sigText, keys)) throw new Error('the fresh signature does not verify against the pinned keys; nothing written');
  writeFileSync(`${file}.sig`, sigText);
  return sigText;
}
