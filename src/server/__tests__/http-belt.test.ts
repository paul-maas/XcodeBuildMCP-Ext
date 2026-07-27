import { afterEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startMcpHttpServer, type McpHttpServerHandle } from '../start-mcp-http-server.ts';

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// Non-destructive takeover ("belt"): a new `initialize` arriving while a tool
// call is in flight must be refused with 503 instead of taking over the session
// and killing the running call. See docs/MCP_HTTP_TRANSPORT_PLAN.md (Stage 6).
describe('http transport — non-destructive takeover (belt)', () => {
  let handle: McpHttpServerHandle | null = null;
  let client: Client | null = null;
  let release: (() => void) | null = null;

  afterEach(async () => {
    release?.(); // never leave the gated tool blocked if an assertion threw
    await client?.close().catch(() => undefined);
    await handle?.close().catch(() => undefined);
    handle = null;
    client = null;
    release = null;
  });

  it('refuses a concurrent initialize with 503 and the in-flight call survives', async () => {
    const entered = deferred();
    const gate = deferred();
    release = gate.resolve;

    const server = new McpServer({ name: 'belt-test', version: '0.0.0' });
    server.registerTool('slow', { description: 'blocks until released' }, async () => {
      entered.resolve(); // POST is now in flight (inflightPosts === 1)
      await gate.promise;
      return { content: [{ type: 'text' as const, text: 'ok' }] };
    });

    handle = await startMcpHttpServer(server, {
      port: 0,
      host: '127.0.0.1',
      sessionTimeoutMs: 0,
    });
    const url = new URL(`http://127.0.0.1:${handle.port}/mcp`);

    client = new Client({ name: 'actor-A', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(url));

    // Start a tool call and leave it in flight; the POST response is held open.
    const callPromise = client.callTool({ name: 'slow', arguments: {} });
    await entered.promise; // deterministic: handler running → inflightPosts === 1

    // A second actor initializes (no session id). The belt must refuse it.
    const probe = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'probe', version: '0' },
        },
      }),
    });
    expect(probe.status).toBe(503);
    const body = (await probe.json()) as { error?: { message?: string } };
    expect(body.error?.message).toContain('Server busy');

    // The running call was neither taken over nor killed.
    gate.resolve();
    const result = (await callPromise) as { content: Array<{ type: string; text: string }> };
    expect(result.content[0]?.text).toBe('ok');
  });
});
