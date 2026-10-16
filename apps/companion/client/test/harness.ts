/** Test-only entry: starts the real client app on a scripted ControlApi (see mock.ts). The spec puts a JSON seed in `window.__seed` before load (no eval: the page runs under the relay's CSP). */
import { start } from '../src/app.ts';
import type { CSession, ControlHost, Tail } from '../src/control/types.ts';
import { MockApi } from './mock.ts';

interface Seed { host?: Partial<ControlHost>; sessions?: CSession[]; tails?: Record<string, Partial<Tail> & Pick<Tail, 'lines'>>; stepUpSupported?: boolean }
declare global { interface Window { __bw: MockApi; __seed?: Seed } }

const api = new MockApi();
window.__bw = api;
const seed = window.__seed;
if (seed) {
  if (seed.host) api.hostState = { ...api.hostState, ...seed.host };
  api.sess = seed.sessions ?? [];
  for (const [sid, t] of Object.entries(seed.tails ?? {})) api.tails.set(sid, { updatedAt: Date.now(), outputShown: false, ...t });
  if (seed.stepUpSupported === false) api.stepUpIsSupported = false;
}
await start({ build: 'test', version: '0.0.0-test', keyId: 'test', expires: '2099-01-01T00:00:00Z' }, { api });
