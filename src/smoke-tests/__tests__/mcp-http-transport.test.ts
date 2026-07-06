import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { connect } from 'node:net';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpTestHarness, type McpTestHarness } from '../mcp-test-harness.ts';
import { expectContent } from '../test-helpers.ts';

let harness: McpTestHarness;

beforeAll(async () => {
  harness = await createMcpTestHarness({
    transport: 'http',
    commandResponses: {
      'simctl list devices': {
        success: true,
        output: JSON.stringify({
          devices: {
            'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
              {
                name: 'iPhone 17 Pro',
                udid: 'AAAAAAAA-1111-2222-3333-444444444444',
                state: 'Shutdown',
                isAvailable: true,
              },
            ],
          },
        }),
      },
    },
  });
}, 30_000);

afterAll(async () => {
  await harness.cleanup();
});

describe('MCP Streamable HTTP transport (e2e)', () => {
  it('initializes a stateful session over HTTP', () => {
    expect(harness.client.getServerVersion()?.name).toBe('xcodebuildmcp');

    const transport = harness.client.transport;
    expect(transport).toBeInstanceOf(StreamableHTTPClientTransport);
    if (transport instanceof StreamableHTTPClientTransport) {
      expect(transport.sessionId).toBeTruthy();
    }
  });

  it('lists tools over HTTP', async () => {
    const { tools } = await harness.client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.some((tool) => tool.name === 'list_sims')).toBe(true);
  });

  it('delivers progress notifications and the final result for a tool call', async () => {
    const progressUpdates: number[] = [];

    const result = await harness.client.callTool({ name: 'list_sims', arguments: {} }, undefined, {
      onprogress: (progress) => {
        progressUpdates.push(progress.progress);
      },
    });

    expect('isError' in result && result.isError === true).toBe(false);
    const content = expectContent(result);
    expect(content.some((item) => item.type === 'text')).toBe(true);

    // The MCP progress heartbeat emits an immediate tick when a progressToken is
    // supplied (see startMcpProgressPump), so at least one notification must have
    // arrived on the request's stream before the result.
    expect(progressUpdates.length).toBeGreaterThanOrEqual(1);
  });

  it('rejects malformed requests without crashing and recovers from a failed initialize', async () => {
    // Deliberately LAST in this file: the raw initialize requests below take
    // over the harness client's session (single-session posture).
    const port = harness.httpPort;
    if (port === undefined) {
      throw new Error('harness.httpPort not set for http transport');
    }
    const baseUrl = `http://127.0.0.1:${port}/mcp`;

    // Absolute-form request target (proxy-style; fetch cannot produce it, so
    // use a raw socket) that the WHATWG URL parser rejects must get a 400,
    // not crash the server via uncaughtException.
    const rawResponse = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => {
        socket.write('GET http://a:99999999/mcp HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n');
      });
      let data = '';
      socket.on('data', (chunk: Buffer) => {
        data += chunk.toString('utf8');
      });
      socket.on('end', () => resolve(data));
      socket.on('error', reject);
      socket.setTimeout(5000, () => socket.destroy(new Error('raw request timed out')));
    });
    expect(rawResponse).toContain('HTTP/1.1 400');

    // Oversized body must get a 413 before any session routing happens.
    const oversized = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'x'.repeat(17 * 1024 * 1024),
    });
    expect(oversized.status).toBe(413);
    await oversized.body?.cancel();

    // An initialize without the required Accept header is rejected up front
    // (406) and must NOT displace the active session via takeover.
    const initializeBody = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'raw-test', version: '1.0.0' },
      },
    });
    const rejected = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: initializeBody,
    });
    expect(rejected.status).toBe(406);
    await rejected.body?.cancel();

    // The harness client's session survived all of the above.
    const { tools } = await harness.client.listTools();
    expect(tools.length).toBeGreaterThan(0);

    // A valid raw initialize still succeeds (and takes over the session —
    // which is why this test runs last in the file).
    const accepted = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: initializeBody,
    });
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get('mcp-session-id')).toBeTruthy();
    await accepted.body?.cancel();
  });
});
