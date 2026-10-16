/**
 * Antigravity CLI (`agy`, Google) as a READ-ONLY adapter (owner decision 7). agy has hooks, but they fire per tool call, not per permission prompt, and a hook's allow is
 * reported to be ignored in its default review mode, so there is no supported per-prompt route to answer from a phone. What this adapter offers is honest and small:
 * it reports that agy is installed and its version, and `doctor` says how a phone sees agy and where Google's own remote control is.
 *  - Waiting cards for agy come from Herdr (enable it: `adapters enable herdr`), which recognises agy and reports `blocked`; they say "Answer on your computer".
 *  - To answer agy from a phone, use Google's own `agy remote-control` (a Google-cloud path: it is not end-to-end encrypted by Botwarren).
 * It installs no hook into agy and reads no file. NOT done, and why: spike S-A1 (does a hook's allow skip agy's prompt) needs a Google login that an isolated run
 * must not use; a hook installer for `~/.gemini/config/hooks.json` is left as next work because its file format and stdin are documented but unverified here.
 * Licence: Apache-2.0.
 */
import { versionProbe } from '../io.ts';
import { NO_CONTROL, type Adapter, type AdapterContext, type AdapterManifest, type Answer, type DeliverResult, type DetectResult, type DoctorLine, type NativeRef, type Revalidation } from '../types.ts';

export const AGY_ID = 'agy';
export const AGY_MANIFEST: AdapterManifest = {
  id: AGY_ID, kind: 'agy', safety: 'A',
  caps: { detect: true, readPending: false, readRecent: false, approve: false, deny: false, presetReply: false, optionAnswer: false },
  reads: [
    '`agy --version` only: whether Antigravity is installed',
    'waiting cards for agy come from Herdr (adapters enable herdr), which recognises it; this adapter installs no hook in agy and reads no file',
    'to answer agy from a phone, use Google\'s own remote control (agy remote-control): that path goes through Google\'s cloud and is not end-to-end encrypted by Botwarren',
  ],
  verified: { versions: [] },
  confirmFloor: { approve: 'always', reply: 'always' },
  observesOutcome: false,
  // protocol 3: no control capability is verified for this tool yet (observe and approve/deny only), so none is claimed
  control: NO_CONTROL,
};

export class AgyAdapter implements Adapter {
  readonly manifest = AGY_MANIFEST;
  private readonly probe: () => Promise<string | null>;
  constructor(o: { versionProbe?: () => Promise<string | null> } = {}) { this.probe = o.versionProbe ?? versionProbe('agy'); }
  async detect(): Promise<DetectResult> {
    const version = await this.probe();
    return version ? { present: true, version, note: 'installed: waiting cards via Herdr, answers via Google\'s own remote control (agy remote-control)' } : { present: false, note: 'agy was not found on PATH' };
  }
  async start(_ctx: AdapterContext): Promise<void> { /* nothing runs */ }
  async stop(): Promise<void> { /* nothing runs */ }
  async revalidate(_n: NativeRef): Promise<Revalidation> { return 'gone'; }
  async deliver(_n: NativeRef, _a: Answer, _who?: { device: string }): Promise<DeliverResult> { return 'unsupported'; }
  release(): void { /* nothing is held */ }
  async doctor(): Promise<DoctorLine[]> {
    const d = await this.detect();
    return [
      { label: 'agy', value: d.present ? `found ${d.version ?? ''}` : d.note ?? 'not found', ok: d.present ? true : null },
      { label: 'agy cards', value: 'from Herdr: botwarren-companion adapters enable herdr (it shows agy as waiting, "Answer on your computer")', ok: null },
      { label: 'agy answers', value: 'not from here. Google\'s own remote control: agy remote-control start (through Google\'s cloud, not end-to-end encrypted by Botwarren)', ok: null },
    ];
  }
}
