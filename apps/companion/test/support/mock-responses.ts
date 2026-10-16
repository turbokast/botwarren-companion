/**
 * A scripted stand-in for the OpenAI Responses API, so a real Codex can be driven without a model, an account or any network: each model turn is the next
 * entry of the script (a tool call, or text). Used by the live Codex test and the capture of fixtures. It listens on loopback only.
 */
import { createServer, type Server } from 'node:http';

export type Step = { tool: { name: string; arguments: Record<string, unknown> } } | { text: string };
export interface MockResponses { port: number; requests: { toolNames: string[] }[]; close(): Promise<void> }

export async function mockResponses(script: readonly Step[]): Promise<MockResponses> {
  const requests: { toolNames: string[] }[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      type Body = { tools?: { name?: string }[]; input?: { type?: string }[] };
      const parse = (): Body | null => { try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Body; } catch { return null; } };
      const j = parse();
      if (req.method !== 'POST' || !(req.url ?? '').endsWith('/responses')) { res.writeHead(404); res.end('{}'); return; }
      requests.push({ toolNames: (j?.tools ?? []).map((t) => t.name ?? '') });
      const k = (j?.input ?? []).filter((i) => i.type === 'function_call_output').length; // one step per tool result already in the conversation
      const step = script[Math.min(k, script.length - 1)]!;
      const id = `resp_${requests.length}`;
      const created = { type: 'response.created', response: { id } };
      const done = { type: 'response.completed', response: { id, usage: { input_tokens: 10, input_tokens_details: null, output_tokens: 5, output_tokens_details: null, total_tokens: 15 } } };
      const item = 'tool' in step
        ? { type: 'function_call', call_id: `call_${k + 1}`, name: step.tool.name, arguments: JSON.stringify(step.tool.arguments) }
        : { type: 'message', role: 'assistant', id: `msg_${k + 1}`, content: [{ type: 'output_text', text: step.text }] };
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      for (const e of [created, { type: 'response.output_item.done', item }, done]) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      res.end();
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  const port = (server.address() as { port: number }).port;
  return { port, requests, close: () => new Promise<void>((ok) => { server.close(() => ok()); server.closeAllConnections?.(); }) };
}
