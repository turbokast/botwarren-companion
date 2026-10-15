/** Test helpers for phone alerts: a fake browser push subscription (keys the test holds) and the receiving side of RFC 8291. */
import { createDecipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto';
import type { PushSub } from '../src/protocol/index.ts';

const b64u = (b: Uint8Array): string => Buffer.from(b).toString('base64url');

/** RFC 8291 Appendix A */
export const RFC8291 = {
  plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
};

/** what a browser does with a push body: returns the plaintext, or throws if it is not for this subscription */
export function decryptPush(body: Buffer, uaPrivate: Buffer, uaPublic: Buffer, auth: Buffer): string {
  const salt = body.subarray(0, 16); const idlen = body[20]!; const asPublic = body.subarray(21, 21 + idlen); const ct = body.subarray(21 + idlen);
  const ua = createECDH('prime256v1'); ua.setPrivateKey(uaPrivate);
  const secret = ua.computeSecret(asPublic);
  const ikm = Buffer.from(hkdfSync('sha256', secret, auth, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  if (plain[plain.length - 1] !== 2) throw new Error('no last-record delimiter');
  return plain.subarray(0, plain.length - 1).toString();
}

export interface FakeSubscription {
  sub: PushSub;
  /** the browser's side: opens a body sealed for this subscription */
  open(body: Buffer): string;
}

export function fakeSubscription(endpoint = 'https://fcm.googleapis.com/fcm/send/fake-endpoint-0123456789'): FakeSubscription {
  const ua = createECDH('prime256v1'); ua.generateKeys();
  const auth = randomBytes(16);
  return { sub: { endpoint, p256dh: b64u(ua.getPublicKey()), auth: b64u(auth) }, open: (body) => decryptPush(body, ua.getPrivateKey(), ua.getPublicKey(), auth) };
}
