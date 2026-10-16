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
import { AGENT_KINDS, CONTROL_MODES, DEFAULT_PRESETS, DEFAULT_PRESET_TEXT, PushSub, SCOPES, SignedSchema, START_MODES, UNLOCK_MS_DEFAULT } from './protocol/index.ts';

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

/**
 * Per-tool adapter settings (companion 0.2.0). Hook tools (Codex, Muse, Copilot): `hold` is `never` (report only, the default) or `away` (hold a
 * permission request up to `holdSeconds`, never more than 45, only while `botwarren-companion away on` is active, then let the tool's own dialog show).
 * Tools that read a local service or a terminal screen (Herdr, OpenCode, agy, Ninox) are OFF until the person turns them on with
 * `botwarren-companion adapters enable <id>`: they read content the hooks did not.
 */
const HookToolCfg = z.object({
  enabled: z.boolean().default(true),
  hold: z.enum(['never', 'away']).default('never'),
  holdSeconds: z.number().int().min(5).max(45).default(30),
  /** versions the person verified themselves with the live checklist (`botwarren-companion adapters verify <tool> <version>`); answering is enabled only for these and the versions the release lists */
  verifiedVersions: z.array(z.string().regex(/^\d{1,4}\.\d{1,4}\.(?:\d{1,4}|\*)$/)).max(5).default([]),
}).strict();
const ReadToolCfg = z.object({ enabled: z.boolean().default(false) }).strict();
export const AdaptersSchema = z.object({
  codex: HookToolCfg.default(HookToolCfg.parse({})),
  muse: HookToolCfg.default(HookToolCfg.parse({})),
  copilot: HookToolCfg.default(HookToolCfg.parse({ enabled: false })),
  herdr: ReadToolCfg.extend({ screenPreview: z.boolean().default(false) }).strict().default({ enabled: false, screenPreview: false }),
  opencode: ReadToolCfg.extend({
    /** the NAME of the environment variable that holds the service password (opt-in); the value is read from the daemon's own environment only, never from a file */
    passwordEnv: z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/).optional(),
    port: z.number().int().min(1024).max(65535).default(4096),
  }).strict().default({ enabled: false, port: 4096 }),
  agy: ReadToolCfg.default({ enabled: false }),
  ninox: ReadToolCfg.extend({ port: z.number().int().min(1024).max(65535).default(8080) }).strict().default({ enabled: false, port: 8080 }),
}).strict();
export type AdaptersConfig = z.infer<typeof AdaptersSchema>;
/**
 * Remote control (protocol 3, see PROTOCOL3.md in the Companion's docs folder). `mode` is `off` after an upgrade: no tail, no history, no prompt, start or free-text answer
 * until the owner runs `botwarren-companion control on|readonly` at this computer. Everything else here can only narrow what a device's scope allows.
 */
export const LaunchEntrySchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,24}$/),
  label: z.string().min(1).max(60),
  harness: z.enum(AGENT_KINDS),
  /** an absolute folder on this computer; never sent to a device */
  root: z.string().min(1).max(400),
  modes: z.array(z.enum(START_MODES)).min(1).max(3).default(['default']),
}).strict();
export type LaunchEntry = z.infer<typeof LaunchEntrySchema>;
export const ControlConfigSchema = z.object({
  mode: z.enum(CONTROL_MODES).default('off'),
  /** only these harnesses may be controlled; empty = every harness whose adapter supports it */
  harnesses: z.array(z.enum(AGENT_KINDS)).max(9).default([]),
  /** only sessions whose folder is one of these (or inside one); empty = any */
  projects: z.array(z.string().min(1).max(400)).max(40).default([]),
  /** prompts into a session that runs without approval prompts (bypass, Ninox workers): refused unless this is set here */
  allowBypass: z.boolean().default(false),
  /** keep a local-only log WITH the text of every command (mode 0600, 30 days) */
  fullLog: z.boolean().default(false),
  unlockMinutes: z.number().int().min(1).max(60).default(UNLOCK_MS_DEFAULT / 60_000),
  promptsPerHour: z.number().int().min(1).max(200).default(10),
  promptsPerMinute: z.number().int().min(1).max(60).default(6),
  startsPerHour: z.number().int().min(1).max(100).default(5),
  startsPerMinute: z.number().int().min(1).max(60).default(3),
  launch: z.array(LaunchEntrySchema).max(12).default([]),
}).strict();
export type ControlConfig = z.infer<typeof ControlConfigSchema>;

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
  adapters: AdaptersSchema.default(AdaptersSchema.parse({})),
  maxActionsPerMinute: z.number().int().min(1).max(60).default(6),
  maxActionsPerHour: z.number().int().min(1).max(600).default(60),
  control: ControlConfigSchema.default(ControlConfigSchema.parse({})),
}).strict();
export type Config = z.infer<typeof ConfigSchema>;

export const EnrollmentSchema = z.object({ v: z.literal(1), relayUrl: z.string().max(300), ticket: SignedSchema, acct: z.string().max(40) }).strict();
export type Enrollment = z.infer<typeof EnrollmentSchema>;

export const DeviceRecord = z.object({
  id: z.string(), name: z.string(), sig: z.string(), kem: z.string(), kemEpoch: z.number().int().min(0), cert: SignedSchema, pairedAt: z.number(), lastSeen: z.number().nullable(),
  /** this phone's Web Push subscription, sent by the phone inside the encrypted channel; absent = alerts off for this phone. Treat as a secret: it is the address of that phone. */
  push: PushSub.optional(),
  /** the protocol revision this phone said it understands (in `sync`); absent = 1 */
  proto: z.number().int().min(1).max(99).optional(),
  /** what this phone's page said it can read (from its `sync`): absent = the first version's short form */
  caps: z.array(z.string().max(12)).max(8).optional(),
  /** protocol 3: what this device may do (see control.ts); absent = `answer`, which is exactly what every device had before 0.3.0 */
  scope: z.enum(SCOPES).optional(),
  /** protocol 3: the owner wants every prompt, free-text answer and start from this device confirmed at the computer, even with a credential */
  confirmEvery: z.boolean().optional(),
  /** protocol 3: the WebAuthn credential registered for step-up (public data only). `key` is a JWK. */
  cred: z.object({
    id: z.string().regex(/^[A-Za-z0-9_-]{8,1024}$/),
    alg: z.union([z.literal(-7), z.literal(-8), z.literal(-257)]),
    key: z.record(z.string(), z.string()),
    signCount: z.number().int().min(0),
    addedAt: z.number(),
  }).strict().optional(),
}).strict();
export type DeviceRecord = z.infer<typeof DeviceRecord>;

export const StateSchema = z.object({
  sendReserved: z.record(z.string(), z.number()).default({}),
  replay: z.record(z.string(), z.number()).default({}),
  revocations: z.array(SignedSchema).max(200).default([]),
  certCtr: z.number().int().default(0),
  rev: z.number().int().default(0),
  lastRotation: z.number().default(0),
  /** "I am away" until this time (ms since the epoch); 0 = not away */
  awayUntil: z.number().default(0),
  /** protocol 3: command ids seen in the last 24 h (`<device 8>:<cid>` -> time and the outcome that was answered), so a retry is never run twice */
  cids: z.record(z.string(), z.object({ t: z.number(), o: z.string().max(400) }).strict()).default({}),
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

  /** the opt-in local-only log WITH command text (mode 0600); kept 30 days by `pruneFullLog` */
  auditFull(fields: Record<string, string | number | boolean | null>): void {
    const line = JSON.stringify({ at: new Date().toISOString(), ...fields });
    try { appendFileSync(this.path('control-full.log'), line + '\n', { mode: 0o600 }); try { chmodSync(this.path('control-full.log'), 0o600); } catch { /* windows */ } } catch { /* never fail the product on a log write */ }
  }

  pruneFullLog(nowMs: number, keepMs = 30 * 86_400_000): void {
    try {
      const keep = readFileSync(this.path('control-full.log'), 'utf8').split('\n').filter((l) => { if (!l) return false; try { return nowMs - Date.parse((JSON.parse(l) as { at: string }).at) <= keepMs; } catch { return false; } });
      writeFileSync(this.path('control-full.log'), keep.length ? keep.join('\n') + '\n' : '', { mode: 0o600 });
    } catch { /* no file */ }
  }

  auditTail(n = 50): string[] {
    try { return readFileSync(this.path('audit.log'), 'utf8').trim().split('\n').slice(-n); } catch { return []; }
  }
}
