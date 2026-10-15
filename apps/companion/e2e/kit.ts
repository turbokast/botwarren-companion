/** Shared by the browser specs: a client built and signed with a throw-away key, and pairing a real browser page with the daemon like a person would. */
import { expect, type Page } from '@playwright/test';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error plain JS modules without types
import { buildClient, signClient } from '../client/scripts/lib.mjs';
import type { World } from '../test/world.ts';
import { connectDaemon } from '../src/ipc.ts';

export const SHOTS = process.env.BW_SHOTS ?? '';

export function signedClient(opts: { signWithUnknownKey?: boolean } = {}) {
  const good = generateKeyPairSync('ed25519');
  const other = generateKeyPairSync('ed25519');
  const spki = (k: typeof good.publicKey) => k.export({ type: 'spki', format: 'der' }).toString('base64');
  const keys = [{ id: 'test-1', spki: spki(good.publicKey) }];
  const dir = mkdtempSync(join(tmpdir(), 'bw-client-'));
  return buildClient({ outDir: dir, keys, version: '0.1.0-test' }).then(({ out }) => {
    const signer = opts.signWithUnknownKey ? other : good;
    signClient({ outDir: out, privateKeyPem: signer.privateKey.export({ type: 'pkcs8', format: 'pem' }), keyId: 'test-1', keys: [{ id: 'test-1', spki: spki(signer.publicKey) }] });
    return out;
  });
}

export async function pairWithBrowser(w: World, page: Page): Promise<void> {
  const link = (await connectDaemon(w.env.BOTWARREN_COMPANION_HOME))!;
  const sasFromHost = new Promise<string>((ok) => { link.onEvent((ev) => { if (ev.t === 'pair_confirm') ok(String(ev.sas)); }); });
  let cid = '';
  link.onEvent((ev) => { if (ev.t === 'pair_confirm') cid = String(ev.cid); });
  const r = await link.request('pair_start');
  await page.goto(w.base);
  await expect(page.getByTestId('code')).toBeVisible();
  await page.getByTestId('code').fill(String(r.code).toLowerCase());
  await page.getByTestId('pair-btn').click();
  const sasOnPhone = (await page.getByTestId('sas').textContent())!;
  expect(sasOnPhone).toBe(await sasFromHost); // the person compares these two numbers
  await link.request('pair_decision', { cid, ok: true });
  await expect(page.getByTestId('conn')).toHaveText('Computer online');
  link.close();
}
