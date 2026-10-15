/**
 * The companion's local files. Everything lives in one directory (mode 0700), every file is mode 0600, writes are atomic. Nothing
 * here is ever uploaded: the host's private keys, the paired-device list, counters and the audit log stay on this machine.
 *
 *   identity.json   host signing key (Ed25519, PKCS#8) and public key
 *   ring.json       host encryption keys by epoch (X25519, PKCS#8)
 *   devices.json    paired devices (public data + the host-signed certificates)
 *   state.json      send counters, replay high-water marks, revocations, last-seen
 *   config.json     relay url, preset replies, confirmation policy, pause
 *   enrollment.json the server-signed ticket that lets this host use the relay
 *   hook.secret     per-install token for the local socket
 *   audit.log       append-only local audit (kinds, outcomes, hashes: never content)
 * Licence: Apache-2.0.
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { DEFAULT_PRESETS, DEFAULT_PRESET_TEXT, PushSub, SignedSchema } from './protocol/index.ts';

export { homeDir, socketPath } from './paths.ts';

export const PolicyMode = z.enum(['off', 'always', 'risky']);
const Clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const AlertsSchema = z.object({
  /** master switch for phone alerts from this computer (a phone also has its own "Alerts" switch) */
  enabled: z.boolean().default(true),
  /** also alert when an agent finished and waits for its next instruction */
  idle: z.boolean().default(false),
  /** a request must still be waiting after this long before anything is sent */
  delaySeconds: z.number().int().min(0).max(300).default(15),
  /** at least this long between two alerts (waiting requests in between are covered by the next one) */
  minGapSeconds: z.number().int().min(0).max(3600).default(60),
  maxPerHour: z.number().int().min(1).max(60).default(12),
  /** this computer's local time; alerts wait until it ends and are sent only if something is still waiting */
  quiet: z.object({ on: z.boolean().default(false), start: Clock.default('22:00'), end: Clock.default('07:00') }).default({ on: false, start: '22:00', end: '07:00' }),
}).strict();
export type AlertsConfig = z.infer<typeof AlertsSchema>;
export const ConfigSchema = z.object({
  v: z.literal(1).default(1),
  name: z.string().min(1).max(40).default('This computer'),
  relayUrl: z.string().max(300).default(''),
  /** relay host suffixes this companion will ever connect to; the server cannot widen it, only local config can */
  allowRelayHosts: z.array(z.string().max(100)).max(5).default(['botwarren.com']),
  presets: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/), label: z.string().min(1).max(60), text: z.string().min(1).max(200), affirm: z.boolean().default(false) })).max(8).default(
    DEFAULT_PRESETS.map((p) => ({ id: p.id, label: p.label, text: DEFAULT_PRESET_TEXT[p.id] ?? p.label, affirm: p.id === 'yes' || p.id === 'continue' })),
  ),
  confirm: z.object({ approve: PolicyMode.default('off'), reply: PolicyMode.default('off') }).default({ approve: 'off', reply: 'off' }),
  requireLocalTools: z.array(z.string().max(60)).max(40).default([]),
  /** how long a PermissionRequest hook waits for a remote answer; 0 = report only, never hold (the safe default until verified live) */
  holdSeconds: z.number().int().min(0).max(600).default(0),
  paused: z.boolean().default(false),
  alerts: AlertsSchema.default(AlertsSchema.parse({})),
  maxActionsPerMinute: z.number().int().min(1).max(60).default(6),
  maxActionsPerHour: z.number().int().min(1).max(600).default(60),
}).strict();
export type Config = z.infer<typeof ConfigSchema>;

export const EnrollmentSchema = z.object({ v: z.literal(1), relayUrl: z.string().max(300), ticket: SignedSchema, acct: z.string().max(40) }).strict();
export type Enrollment = z.infer<typeof EnrollmentSchema>;

export const DeviceRecord = z.object({
  id: z.string(), name: z.string(), sig: z.string(), kem: z.string(), kemEpoch: z.number().int().min(0), cert: SignedSchema, pairedAt: z.number(), lastSeen: z.number().nullable(),
  /** this phone's Web Push subscription, sent by the phone inside the encrypted channel; absent = alerts off for this phone. Treat as a secret: it is the address of that phone. */
  push: PushSub.optional(),
}).strict();
export type DeviceRecord = z.infer<typeof DeviceRecord>;

export const StateSchema = z.object({
  sendReserved: z.record(z.string(), z.number()).default({}),
  replay: z.record(z.string(), z.number()).default({}),
  revocations: z.array(SignedSchema).max(200).default([]),
  certCtr: z.number().int().default(0),
  rev: z.number().int().default(0),
  lastRotation: z.number().default(0),
}).strict();
export type State = z.infer<typeof StateSchema>;

export class Store {
  readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { chmodSync(dir, 0o700); } catch { /* windows */ }
  }
  path(name: string): string { return join(this.dir, name); }
  exists(name: string): boolean { return existsSync(this.path(name)); }

  readJson<T>(name: string, schema: z.ZodType<T>, fallback: () => T): T {
    try { return schema.parse(JSON.parse(readFileSync(this.path(name), 'utf8'))); } catch { return fallback(); }
  }

  writeJson(name: string, data: unknown): void {
    const tmp = this.path(`${name}.${randomBytes(4).toString('hex')}.tmp`);
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, this.path(name));
    try { chmodSync(this.path(name), 0o600); } catch { /* windows */ }
  }

  config(): Config { return this.readJson('config.json', ConfigSchema, () => ConfigSchema.parse({})); }
  saveConfig(c: Config): void { this.writeJson('config.json', c); }
  enrollment(): Enrollment | null { return this.readJson<Enrollment | null>('enrollment.json', EnrollmentSchema.nullable(), () => null); }
  devices(): DeviceRecord[] { return this.readJson('devices.json', z.array(DeviceRecord), () => []); }
  saveDevices(d: DeviceRecord[]): void { this.writeJson('devices.json', d); }
  state(): State { return this.readJson('state.json', StateSchema, () => StateSchema.parse({})); }
  saveState(s: State): void { this.writeJson('state.json', s); }

  /** per-install secret for the local socket; created on first use */
  hookSecret(): string {
    try { return readFileSync(this.path('hook.secret'), 'utf8').trim(); } catch {
      const s = randomBytes(24).toString('base64url');
      writeFileSync(this.path('hook.secret'), s + '\n', { mode: 0o600 });
      return s;
    }
  }

  audit(kind: string, fields: Record<string, string | number | boolean | null> = {}): void {
    const line = JSON.stringify({ at: new Date().toISOString(), kind, ...fields });
    try { appendFileSync(this.path('audit.log'), line + '\n', { mode: 0o600 }); } catch { /* never fail the product on a log write */ }
  }

  auditTail(n = 50): string[] {
    try { return readFileSync(this.path('audit.log'), 'utf8').trim().split('\n').slice(-n); } catch { return []; }
  }
}
