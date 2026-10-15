import { afterEach, describe, expect, it } from 'vitest';
import { assistant, startWorld, transcript, type World } from './world.ts';
import { CAP_LONG } from '../src/protocol/index.ts';

/**
 * 0.1.3, item 3 of the owner's second test: "relay queue still overflowing" (321 frames, 124 overflow drops, 19 queued with the phone away).
 * Root cause found on the owner's machine: the RUNNING daemon was still 0.1.1 (its service unit named 0.1.2, but nothing had restarted it), and 0.1.1 sends a
 * frame per hook event with no replace key. The relay now also caps what one sender may have queued (see apps/relay/test/queue.test.ts); this test is the
 * other half: a CURRENT computer, an hour of busy hook traffic across three sessions, the phone away the whole time.
 */
describe('an hour of PostToolUse churn across three sessions with the phone away', () => {
  let w: World | null = null;
  afterEach(async () => { await w?.close(); w = null; });
  const queues = (x: World): { r?: string; f: string }[] => [...(x.relay as unknown as { queues: Map<string, { r?: string; f: string }[]> }).queues.values()].flat();
  const counter = (x: World, k: string): number => x.relay.counters.get(k) ?? 0;

  it('leaves at most a handful of frames at the relay, and the phone that comes back has the latest of every session and the request that is pending now', async () => {
    w = await startWorld({ stateGapMs: 5 }); // the host's 2 s throttle, shortened so a "second" of the hour takes a few milliseconds
    const phone = await w.pairDevice('Phone', { caps: [CAP_LONG] });
    await phone.waitFor(() => phone.states.length >= 1);
    phone.stop(); // the phone leaves and stays away for the whole hour
    await new Promise((r) => setTimeout(r, 200));

    const sessions = [{ id: 'sess-a', cwd: '/work/alpha' }, { id: 'sess-b', cwd: '/work/beta' }, { id: 'sess-c', cwd: '/work/gamma' }];
    const hookIn = (s: (typeof sessions)[number], event: string, extra: Record<string, unknown> = {}) => ({ session_id: s.id, cwd: s.cwd, hook_event_name: event, ...extra });
    const t0 = counter(w, 'frames');
    let pushes = 0;
    for (let sec = 0; sec < 1800; sec++) { // 1800 "seconds" x 2 events: a tool call after every tool call
      const s = sessions[sec % 3]!;
      await w.hook('PostToolUse', hookIn(s, 'PostToolUse', { tool_name: 'Read' }));
      if (sec % 30 < 3 && sec < 1500) {
        // every 30 seconds a session is prompted again and answers: its transcript grows, a new "waiting for your next instruction" request appears
        const tp = transcript(w.claudeDir, [assistant(`${s.cwd}: step ${sec} of the job done. `.repeat(20))]);
        await w.hook('UserPromptSubmit', hookIn(s, 'UserPromptSubmit'));
        await w.hook('Stop', hookIn(s, 'Stop', { transcript_path: tp }));
        pushes++;
      }
    }
    await new Promise((r) => setTimeout(r, 400)); // the throttle's trailing edge
    const sent = counter(w, 'frames') - t0;
    expect(pushes).toBeGreaterThan(100);
    expect(sent).toBeGreaterThanOrEqual(2); // the host really was sending states all along (the 2 s throttle runs on real time: a slow CI runner sends fewer)

    // the relay holds the newest state, the newest acknowledgement and nothing else
    const q = queues(w);
    expect(q.length).toBeLessThanOrEqual(3);
    expect(q.filter((x) => x.r === 's')).toHaveLength(1);
    expect(counter(w, 'queue_overflow')).toBe(0);
    expect(counter(w, 'queue_trimmed')).toBe(0);
    expect(counter(w, 'queue_replaced')).toBeGreaterThan(0);

    // (the order of the sessions in the state used to follow their last EVENT, so three busy sessions reordered it on every tool call: each hook event
    // then counted as a change. It now follows the last change of status.)
    // PostToolUse alone is silent: once each session shows "working" (one change), 600 more of them send nothing at all
    for (const s of sessions) await w.hook('PostToolUse', hookIn(s, 'PostToolUse', { tool_name: 'Read' }));
    await new Promise((r) => setTimeout(r, 300));
    const before = counter(w, 'frames');
    for (let i = 0; i < 600; i++) await w.hook('PostToolUse', hookIn(sessions[i % 3]!, 'PostToolUse', { tool_name: 'Read' }));
    await new Promise((r) => setTimeout(r, 200));
    expect(counter(w, 'frames')).toBe(before);

    // the phone comes back: a handful of frames, the latest state of all three sessions, each with the request that is pending now
    phone.connect();
    await phone.waitFor(() => phone.online);
    await phone.waitFor(() => phone.latest?.sessions.length === 3, 8000);
    expect(phone.kinds.length).toBeLessThanOrEqual(5);
    expect(phone.latest!.sessions.map((s) => s.label).sort()).toEqual(['alpha', 'beta', 'gamma']);
    expect(phone.latest!.sessions.every((s) => s.pending?.kind === 'idle' || s.status === 'working')).toBe(true);
  }, 240_000);
});
