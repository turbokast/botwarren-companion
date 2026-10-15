#!/usr/bin/env node
/**
 * botwarren-companion: the command line of the Botwarren Companion (Apache-2.0).
 * The `hook` command is first and imports almost nothing so it stays fast: it runs for every Claude Code event.
 */
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const cmd = argv[0];

async function main(): Promise<number> {
  if (cmd === 'hook') {
    const { runHook } = await import('./claude/hookClient.ts');
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    const out = await runHook(String(argv[1] ?? ''), Buffer.concat(chunks).toString('utf8'));
    if (out) process.stdout.write(out + '\n');
    return 0; // always: a hook problem must never disturb Claude Code
  }
  if (cmd === 'channel') {
    const { runChannelServer } = await import('./claude/channel.ts');
    await runChannelServer({ stdin: process.stdin, stdout: process.stdout });
    return 0;
  }
  const { run } = await import('./commands.ts');
  return run(argv, { script: fileURLToPath(import.meta.url), node: process.execPath, ask: (q) => new Promise<string>((ok) => { const rl = createInterface({ input: process.stdin, output: process.stdout }); rl.question(q, (a) => { rl.close(); ok(a); }); }) });
}

main().then((c) => process.exit(c), (e: unknown) => { process.stderr.write(`botwarren-companion: ${(e as Error).message}\n`); process.exit(1); });
