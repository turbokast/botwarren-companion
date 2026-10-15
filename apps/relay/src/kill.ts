/**
 * Kill switches: global, per account, per host, per device. Sources: the admin endpoint (immediate, in memory), the environment
 * (RELAY_GLOBAL_KILL=1 at boot) and the signed kill list fetched from botwarren.com (durable). A kill closes live sockets at once.
 * Licence: Apache-2.0.
 */
import { verifyKillList, type Bytes } from '@botwarren/companion/protocol';

export type KillScope = 'global' | 'account' | 'host' | 'device';

export class KillState {
  global = false;
  readonly accounts = new Set<string>();
  readonly hosts = new Set<string>();
  readonly devices = new Set<string>();
  /** highest signed list sequence applied, and the time of the newest list (an older list is a replay and is refused) */
  seq = -1;
  iat = 0;
  /** parts that came from the signed list (replaced wholesale by the next list); admin-set kills stay until unkilled */
  private fromList = { accounts: new Set<string>(), hosts: new Set<string>(), devices: new Set<string>(), global: false };

  set(scope: KillScope, id: string | undefined, on: boolean): void {
    if (scope === 'global') { this.global = on; return; }
    if (!id) return;
    const s = scope === 'account' ? this.accounts : scope === 'host' ? this.hosts : this.devices;
    if (on) s.add(id); else s.delete(id);
  }

  blocked(acct: string, host: string, dev?: string): boolean {
    return this.global || this.accounts.has(acct) || this.hosts.has(host) || (dev !== undefined && this.devices.has(dev));
  }

  /** apply a verified list: kills it names are added, kills it dropped (that it previously named) are lifted */
  applyList(l: { seq: number; iat: number; global: boolean; accounts: string[]; hosts: string[]; devices: string[] }): boolean {
    if (l.seq < this.seq || l.iat < this.iat) return false;
    this.seq = l.seq; this.iat = l.iat;
    const swap = (cur: Set<string>, prev: Set<string>, next: string[]) => { for (const x of prev) cur.delete(x); prev.clear(); for (const x of next) { cur.add(x); prev.add(x); } };
    swap(this.accounts, this.fromList.accounts, l.accounts);
    swap(this.hosts, this.fromList.hosts, l.hosts);
    swap(this.devices, this.fromList.devices, l.devices);
    if (this.fromList.global || l.global) this.global = l.global;
    this.fromList.global = l.global;
    return true;
  }
}

export async function fetchKillList(url: string, trusted: readonly Bytes[], fetchImpl: typeof fetch = fetch): Promise<ReturnType<typeof verifyKillList> | null> {
  try {
    const res = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const text = await res.text();
    if (text.length > 400_000) return null;
    return verifyKillList(JSON.parse(text), trusted);
  } catch { return null; }
}
