/**
 * Interoperability of the hand-written MCP channel server with the OFFICIAL MCP SDK client (a devDependency used only here):
 * initialize handshake, declared capabilities, instructions, empty tool list, and the two channel notifications in both directions.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { startWorld, type World } from './world.ts';

let w: World | null = null;
afterEach(async () => { await w?.close(); w = null; });

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

describe('channel server vs the official MCP SDK client', () => {
  it('handshake, capabilities, instructions, no tools', async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: ['--disable-warning=ExperimentalWarning', cli, 'channel'], env: { ...process.env, BOTWARREN_COMPANION_HOME: '/nonexistent-bw-home' } as Record<string, string> });
    const client = new Client({ name: 'claude-code-sim', version: '0' }, { capabilities: {} });
    await client.connect(transport);
    const caps = client.getServerCapabilities() as { experimental?: Record<string, unknown>; tools?: unknown };
    expect(Object.keys(caps.experimental ?? {}).sort()).toEqual(['claude/channel', 'claude/channel/permission']);
    expect(client.getServerVersion()?.name).toBe('botwarren-companion');
    expect(client.getInstructions()).toContain('<channel source="botwarren-companion"');
    expect((await client.listTools()).tools).toEqual([]);
    await client.ping();
    await client.close();
  }, 30_000);

  it('permission relay and reply delivery through the real daemon, in both directions', async () => {
    w = await startWorld();
    const d = await w.pairDevice();
    const transport = new StdioClientTransport({ command: process.execPath, args: ['--disable-warning=ExperimentalWarning', cli, 'channel'], env: { ...process.env, ...w.env } as Record<string, string>, cwd: w.dir });
    const client = new Client({ name: 'claude-code-sim', version: '0' }, { capabilities: {} });
    const got: { method: string; params: unknown }[] = [];
    const schema = (method: string) => z.object({ method: z.literal(method), params: z.record(z.string(), z.unknown()) });
    client.setNotificationHandler(schema('notifications/claude/channel/permission') as never, (n: { method: string; params: unknown }) => { got.push(n); });
    client.setNotificationHandler(schema('notifications/claude/channel') as never, (n: { method: string; params: unknown }) => { got.push(n); });
    await client.connect(transport);

    await client.notification({ method: 'notifications/claude/channel/permission_request', params: { request_id: 'abcde', tool_name: 'Bash', description: 'Run tests', input_preview: '{"command":"pnpm test"}' } } as never);
    const p = await d.waitFor(() => d.latest?.sessions.find((s) => s.pending)?.pending);
    expect(p).toMatchObject({ tool: 'Bash', summary: 'Run tests' });
    const sid = d.latest!.sessions.find((s) => s.pending)!.sid;
    await d.act({ rid: p.rid, sid, a: 'approve', bind: p.bind });
    await d.waitFor(() => got.find((g) => g.method === 'notifications/claude/channel/permission'));
    expect(got[0]!.params).toEqual({ request_id: 'abcde', behavior: 'allow' });
    await client.close();
  }, 40_000);
});
