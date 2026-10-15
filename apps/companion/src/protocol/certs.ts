/**
 * Signed documents: the server-signed host enrolment ticket, the host-signed device certificate, revocations, the signed kill list,
 * and the WebSocket auth proof. All use an exact-bytes detached signature with a domain string (see envelope.ts DOMAIN).
 * Licence: Apache-2.0.
 */
import { z } from 'zod';
import { b64u, concat, fromUtf8, unb64u, utf8, type Bytes } from './bytes.ts';
import { DOMAIN } from './envelope.ts';
import { idOf, sign, verify, type Identity } from './keys.ts';

export interface Signed { j: string; s: string }
export const SignedSchema = z.object({ j: z.string().max(4096), s: z.string().length(86) }).strict();

async function signDoc(by: Identity, domain: string, obj: unknown): Promise<Signed> {
  const j = utf8(JSON.stringify(obj));
  return { j: b64u(j), s: b64u(await sign(by, domain, j)) };
}

async function openDoc(doc: unknown, pub: Bytes, domain: string): Promise<unknown | null> {
  const p = SignedSchema.safeParse(doc);
  if (!p.success) return null;
  try {
    const j = unb64u(p.data.j);
    if (!(await verify(pub, unb64u(p.data.s), domain, j))) return null;
    return JSON.parse(fromUtf8(j));
  } catch { return null; }
}

const Id = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const Key = z.string().regex(/^[A-Za-z0-9_-]{43}$/); // 32 bytes b64u

// ---------------------------------------------------------------- host enrolment ticket (signed by the botwarren.com ticket key)
export const Ticket = z.object({ v: z.literal(1), acct: z.string().regex(/^[A-Za-z0-9_-]{16,40}$/), host: Id, hostSig: Key, iat: z.number().int(), exp: z.number().int() }).strict();
export type Ticket = z.infer<typeof Ticket>;

export async function signTicket(serverKey: Identity, t: Ticket): Promise<Signed> { return signDoc(serverKey, DOMAIN.ticket, t); }

/** Valid if signed by any trusted server key, not expired, and bound to the host key it names. */
export async function verifyTicket(doc: unknown, trusted: readonly Bytes[], now: number): Promise<Ticket | null> {
  for (const k of trusted) {
    const o = await openDoc(doc, k, DOMAIN.ticket);
    if (o === null) continue;
    const t = Ticket.safeParse(o);
    if (!t.success || t.data.exp <= now || t.data.iat > now + 120_000) return null;
    if ((await idOf(unb64u(t.data.hostSig))) !== t.data.host) return null;
    return t.data;
  }
  return null;
}

// ---------------------------------------------------------------- device certificate (signed by the host)
export const DeviceCert = z.object({
  v: z.literal(1), acct: z.string().regex(/^[A-Za-z0-9_-]{16,40}$/), host: Id, dev: Id, sig: Key, kem: Key,
  name: z.string().min(1).max(40), iat: z.number().int(), ctr: z.number().int().min(0),
}).strict();
export type DeviceCert = z.infer<typeof DeviceCert>;

export async function signDeviceCert(host: Identity, c: DeviceCert): Promise<Signed> { return signDoc(host, DOMAIN.cert, c); }

export async function verifyDeviceCert(doc: unknown, hostSigPub: Bytes): Promise<DeviceCert | null> {
  const o = await openDoc(doc, hostSigPub, DOMAIN.cert);
  if (o === null) return null;
  const c = DeviceCert.safeParse(o);
  if (!c.success) return null;
  if ((await idOf(unb64u(c.data.sig))) !== c.data.dev) return null;
  if ((await idOf(hostSigPub)) !== c.data.host) return null;
  return c.data;
}

// ---------------------------------------------------------------- revocation (signed by the host; a device may also revoke itself, see relay)
export const Revocation = z.object({ v: z.literal(1), host: Id, dev: Id, iat: z.number().int() }).strict();
export type Revocation = z.infer<typeof Revocation>;
export async function signRevocation(host: Identity, r: Revocation): Promise<Signed> { return signDoc(host, DOMAIN.revoke, r); }
export async function verifyRevocation(doc: unknown, hostSigPub: Bytes): Promise<Revocation | null> {
  const o = await openDoc(doc, hostSigPub, DOMAIN.revoke);
  const r = o === null ? null : Revocation.safeParse(o);
  return r?.success ? r.data : null;
}

// ---------------------------------------------------------------- signed kill list (server -> relay, the durable kill switch)
export const KillList = z.object({
  v: z.literal(1), seq: z.number().int().min(0), iat: z.number().int(), global: z.boolean(),
  accounts: z.array(z.string().max(40)).max(10_000), hosts: z.array(Id).max(10_000), devices: z.array(Id).max(10_000),
}).strict();
export type KillList = z.infer<typeof KillList>;
export async function signKillList(serverKey: Identity, k: KillList): Promise<Signed> { return signDoc(serverKey, DOMAIN.killlist, k); }
export async function verifyKillList(doc: unknown, trusted: readonly Bytes[]): Promise<KillList | null> {
  for (const k of trusted) {
    const o = await openDoc(doc, k, DOMAIN.killlist);
    if (o === null) continue;
    const r = KillList.safeParse(o);
    return r.success ? r.data : null;
  }
  return null;
}

// ---------------------------------------------------------------- WebSocket auth proof
export const authInput = (nonce: Bytes, aud: string, id: string): Bytes => concat(nonce, utf8('|'), utf8(aud), utf8('|'), utf8(id));
export async function signAuth(who: Identity, nonce: Bytes, aud: string): Promise<string> { return b64u(await sign(who, DOMAIN.auth, authInput(nonce, aud, who.id))); }
export async function verifyAuth(pub: Bytes, sigB64: string, nonce: Bytes, aud: string, id: string): Promise<boolean> {
  try { return await verify(pub, unb64u(sigB64), DOMAIN.auth, authInput(nonce, aud, id)); } catch { return false; }
}
