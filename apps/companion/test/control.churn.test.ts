import { afterEach, describe, expect, it } from 'vitest';
import { controlWorld, sleep, type ControlWorld } from './support/control-world.ts';

let cw: ControlWorld | null = null;
afterEach(async () => { await cw?.close(); cw = null; });
const queues = (x: ControlWorld): { r?: string; f: string; t?: string }[] => [...(x.w.relay as unknown as { queues: Map<string, { r?: string; f: string }[]> }).queues.values()].flat();
const counter = (x: ControlWorld, k: string): number => x.w.relay.counters.get(k) ?? 0;

describe('live tail under churn: the relay queue stays bounded', () => {
  it('an hour of output across three watched sessions with the phone away leaves at most one tail window per session at the relay', async () => {
    cw = await controlWorld({ world: { stateGapMs: 5, tailGapMs: 5 } });
    const keys = ['c-a', 'c-b', 'c-c']; const sids: string[] = [];
    for (const k of keys) sids.push((await cw.session(k)).sid);
    for (const sid of sids) await cw.phone.send('watch', { sid, on: true });
    await cw.phone.waitFor(() => sids.every((sid) => cw!.phone.tails.some((t) => t.sid === sid)));
    cw.phone.stop(); // the phone leaves and stays away for the whole hour
    await sleep(200);
    const t0 = counter(cw, 'frames');
    for (let sec = 0; sec < 1800; sec++) {
      const k = keys[sec % 3]!;
      cw.fake.say(k, `step ${sec} of the job. `.repeat(30)); // 2 lines a "second" per session mix: assistant text and tool lines
      cw.fake.tool(k, `Edit src/file${sec % 50}.ts`, `output ${sec}`); // tool output is off: dropped
      if (sec % 30 === 0) { cw.fake.work(k); } else if (sec % 30 === 15) cw.fake.finishTurn(k);
      if (sec % 100 === 0) await sleep(8); // let the host's trailing edges run now and then
    }
    await sleep(500);
    const sent = counter(cw, 'frames') - t0;
    expect(sent).toBeGreaterThanOrEqual(3);
    const q = queues(cw);
    expect(q.length).toBeLessThanOrEqual(8);
    for (const sid of sids) expect(q.filter((x) => x.r === `w${sid.slice(0, 8)}`).length).toBeLessThanOrEqual(1);
    expect(q.filter((x) => x.r === 's').length).toBeLessThanOrEqual(1);
    expect(counter(cw, 'queue_overflow')).toBe(0);
    expect(counter(cw, 'queue_trimmed')).toBe(0);
    expect(counter(cw, 'queue_replaced')).toBeGreaterThan(0);
    // the host holds only a bounded ring of what happened, not an hour of it
    for (const k of keys) expect(cw.w.daemon.host.sessions.byKey(k)!.tail.size).toBeLessThanOrEqual(300);
  });

  it('with the production relay limits and a 1 s gap, three busy watched sessions never make the relay rate-limit the computer', async () => {
    cw = await controlWorld({ world: { stateGapMs: 2000, tailGapMs: 1000, relay: {} } });
    const keys = ['p-a', 'p-b', 'p-c']; const sids: string[] = [];
    for (const k of keys) sids.push((await cw.session(k)).sid);
    for (const sid of sids) await cw.phone.send('watch', { sid, on: true });
    const before = cw.phone.tails.length;
    const end = Date.now() + 7000;
    let i = 0;
    while (Date.now() < end) { for (const k of keys) cw.fake.say(k, `line ${i}`); i++; await sleep(40); }
    await sleep(1200);
    const frames = cw.phone.tails.length - before;
    expect(frames).toBeGreaterThanOrEqual(3);
    expect(frames).toBeLessThanOrEqual(3 + 9); // burst 3, then one a second across all sessions
    expect(counter(cw, 'rate_limited')).toBe(0);
    expect(cw.w.daemon.host.relayState).toBe('online');
    // every session still got its newest window
    for (const sid of sids) expect(cw.phone.tails.filter((t) => t.sid === sid).at(-1)!.last).toBeGreaterThan(30);
  }, 30_000);
});
