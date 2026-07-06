/**
 * MCP HTTP Server - native Streamable HTTP transport
 *
 * Serves the MCP server over HTTP using the SDK's StreamableHTTPServerTransport
 * bound to a plain Node `http.createServer` — no external bridge process and no
 * additional npm dependencies. Replaces the former supergateway stdio bridge
 * (see docs/MCP_HTTP_TRANSPORT_PLAN.md, Stage 3 / Layer B): the native transport
 * associates request-scoped notifications (progress heartbeat) with their
 * originating request stream, and an HTTP-side disconnect no longer tears down
 * the server process.
 *
 * Session model: stateful (`mcp-session-id` header). One McpServer instance is
 * shared across sessions, and the SDK protocol binds to a single transport at a
 * time, so a new `initialize` request takes over: the previous session's
 * transport is closed and the new one is connected ("last client wins"). This
 * matches the single-session posture documented in docs/CONFIGURATION.md — the
 * intended deployment is one dev container talking to one host MCP server.
 */

import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { log } from '../utils/logger.ts';
import { toErrorMessage } from '../utils/errors.ts';

const MCP_ENDPOINT_PATH = '/mcp';
const SESSION_ID_HEADER = 'mcp-session-id';
// Two orders of magnitude above the largest observed MCP payloads (~150 KB
// structured tool results); bounds memory without ever getting in the way of
// legitimate traffic.
const MAX_REQUEST_BODY_BYTES = 16 * 1024 * 1024;

export interface McpHttpServerOptions {
  port: number;
  host: string;
  /** Close a session after this many milliseconds without an open or incoming request. 0 disables the timeout. */
  sessionTimeoutMs: number;
}

export interface McpHttpServerHandle {
  /** The actual bound port (differs from `options.port` when 0 was passed for an ephemeral port). */
  port: number;
  close(): Promise<void>;
}

interface McpHttpSession {
  transport: StreamableHTTPServerTransport;
  /** Open HTTP requests currently routed to this session (POST response streams, standalone GET stream). */
  inflightRequests: number;
  idleTimer: NodeJS.Timeout | null;
}

class RequestBodyTooLargeError extends Error {
  constructor() {
    super(`Request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes`);
    this.name = 'RequestBodyTooLargeError';
  }
}

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    req.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_REQUEST_BODY_BYTES) {
        req.pause();
        reject(new RequestBodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

function respondJsonRpcError(
  res: ServerResponse,
  statusCode: number,
  code: number,
  message: string,
  headers?: Record<string, string>,
): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(statusCode, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

function getSessionIdHeader(req: IncomingMessage): string | undefined {
  const header = req.headers[SESSION_ID_HEADER];
  return Array.isArray(header) ? header[0] : header;
}

/**
 * Start the MCP server on a native Streamable HTTP transport.
 *
 * The returned handle closes all session transports first and then the HTTP
 * listener, matching the shutdown sequence in docs/MCP_HTTP_TRANSPORT_PLAN.md
 * (Stage 3.4).
 */
export async function startMcpHttpServer(
  server: McpServer,
  options: McpHttpServerOptions,
): Promise<McpHttpServerHandle> {
  const sessions = new Map<string, McpHttpSession>();

  const clearIdleTimer = (session: McpHttpSession): void => {
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
  };

  // A session is live only while its transport is still the one registered in
  // the map. Guards below keep timers armed via late res-close events on a
  // replaced ("taken over") session from closing its transport a second time:
  // the SDK fires onclose on every close() call, and the chained
  // Protocol._onclose would detach whatever transport is currently bound —
  // silently severing the active session.
  const isLiveSession = (session: McpHttpSession): boolean => {
    const sessionId = session.transport.sessionId;
    return sessionId !== undefined && sessions.get(sessionId) === session;
  };

  // Arm the idle timer only while no HTTP request is open for the session, so a
  // long-running tool call (held-open POST response) can never be reaped mid-run.
  const armIdleTimer = (session: McpHttpSession): void => {
    clearIdleTimer(session);
    if (options.sessionTimeoutMs <= 0 || session.inflightRequests > 0 || !isLiveSession(session)) {
      return;
    }
    session.idleTimer = setTimeout(() => {
      if (!isLiveSession(session)) {
        return;
      }
      const sessionId = session.transport.sessionId;
      log(
        'info',
        `[mcp-http] Session ${sessionId} idle for ${options.sessionTimeoutMs} ms; closing`,
      );
      void session.transport.close().catch((error: unknown) => {
        log(
          'warn',
          `[mcp-http] Failed to close idle session ${sessionId}: ${toErrorMessage(error)}`,
        );
      });
    }, options.sessionTimeoutMs);
    session.idleTimer.unref();
  };

  const trackRequest = (session: McpHttpSession, res: ServerResponse): void => {
    clearIdleTimer(session);
    session.inflightRequests += 1;
    res.once('close', () => {
      session.inflightRequests -= 1;
      armIdleTimer(session);
    });
  };

  const createSessionTransport = async (): Promise<McpHttpSession> => {
    // The SDK protocol allows a single bound transport; close the previous
    // session before connecting the new one ("last client wins").
    for (const [sessionId, session] of sessions) {
      log('info', `[mcp-http] New initialize request; closing previous session ${sessionId}`);
      clearIdleTimer(session);
      await session.transport.close().catch((error: unknown) => {
        log('warn', `[mcp-http] Failed to close session ${sessionId}: ${toErrorMessage(error)}`);
      });
      sessions.delete(sessionId);
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId: string): void => {
        sessions.set(sessionId, session);
        log('info', `[mcp-http] Session initialized: ${sessionId}`);
      },
    });
    const session: McpHttpSession = { transport, inflightRequests: 0, idleTimer: null };

    // Set before server.connect() so the SDK chains (not replaces) these handlers.
    transport.onclose = (): void => {
      clearIdleTimer(session);
      const sessionId = transport.sessionId;
      if (sessionId && sessions.delete(sessionId)) {
        log('info', `[mcp-http] Session closed: ${sessionId}`);
      }
    };
    transport.onerror = (error: Error): void => {
      log('warn', `[mcp-http] Transport error: ${toErrorMessage(error)}`);
    };

    await server.connect(transport);
    return session;
  };

  const handleMcpRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const sessionId = getSessionIdHeader(req);

    if (req.method === 'POST') {
      let parsedBody: unknown;
      try {
        const rawBody = await readRequestBody(req);
        parsedBody = rawBody.length > 0 ? JSON.parse(rawBody) : undefined;
      } catch (error) {
        if (error instanceof RequestBodyTooLargeError) {
          // Connection: close makes Node tear the socket down after the
          // response, discarding whatever the client is still uploading.
          respondJsonRpcError(res, 413, -32000, 'Request body too large', {
            Connection: 'close',
          });
        } else {
          respondJsonRpcError(res, 400, -32700, 'Parse error');
        }
        return;
      }

      const existingSession = sessionId ? sessions.get(sessionId) : undefined;
      if (sessionId && existingSession) {
        trackRequest(existingSession, res);
        await existingSession.transport.handleRequest(req, res, parsedBody);
        return;
      }
      if (sessionId) {
        // Unknown or expired session: 404 tells spec-compliant clients to re-initialize.
        respondJsonRpcError(res, 404, -32001, 'Session not found');
        return;
      }
      if (isInitializeRequest(parsedBody)) {
        // The SDK validates these headers inside handleRequest, but by then
        // the previous session has already been closed for takeover — an
        // invalid client must not displace the active session. Checks mirror
        // webStandardStreamableHttp.js exactly.
        const acceptHeader = req.headers.accept;
        if (
          !acceptHeader?.includes('application/json') ||
          !acceptHeader.includes('text/event-stream')
        ) {
          respondJsonRpcError(
            res,
            406,
            -32000,
            'Not Acceptable: Client must accept both application/json and text/event-stream',
          );
          return;
        }
        const contentType = req.headers['content-type'];
        if (!contentType || !contentType.includes('application/json')) {
          respondJsonRpcError(
            res,
            415,
            -32000,
            'Unsupported Media Type: Content-Type must be application/json',
          );
          return;
        }

        const session = await createSessionTransport();
        trackRequest(session, res);
        try {
          await session.transport.handleRequest(req, res, parsedBody);
        } finally {
          if (session.transport.sessionId === undefined) {
            // Initialization did not complete (e.g. the SDK rejected the request
            // headers, or the connection died). The transport is bound to the
            // shared McpServer but has no session, so nothing would ever close
            // it — and every future server.connect() would throw "Already
            // connected". Unbind it here.
            await session.transport.close().catch((error: unknown) => {
              log(
                'warn',
                `[mcp-http] Failed to close unestablished session transport: ${toErrorMessage(error)}`,
              );
            });
          }
        }
        return;
      }
      respondJsonRpcError(res, 400, -32000, 'Bad Request: No valid session ID provided');
      return;
    }

    if (req.method === 'GET' || req.method === 'DELETE') {
      const session = sessionId ? sessions.get(sessionId) : undefined;
      if (!sessionId || !session) {
        respondJsonRpcError(res, 404, -32001, 'Session not found');
        return;
      }
      trackRequest(session, res);
      await session.transport.handleRequest(req, res);
      return;
    }

    res.writeHead(405, { Allow: 'POST, GET, DELETE' });
    res.end();
  };

  const httpServer = createHttpServer((req, res) => {
    // Node's parser passes absolute-form request targets (proxy-style) through
    // verbatim; some of them make the WHATWG URL constructor throw, and a
    // synchronous throw here would escalate to uncaughtException → shutdown.
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      respondJsonRpcError(res, 400, -32000, 'Bad Request: Invalid request target');
      return;
    }
    if (pathname !== MCP_ENDPOINT_PATH) {
      respondJsonRpcError(res, 404, -32000, 'Not found');
      return;
    }
    void handleMcpRequest(req, res).catch((error: unknown) => {
      log('error', `[mcp-http] Request handling failed: ${toErrorMessage(error)}`);
      respondJsonRpcError(res, 500, -32603, 'Internal server error');
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onListenError = (error: Error): void => {
      reject(error);
    };
    httpServer.once('error', onListenError);
    httpServer.listen(options.port, options.host, () => {
      httpServer.removeListener('error', onListenError);
      resolve();
    });
  });

  // Keep a persistent listener: a post-listen 'error' (e.g. EMFILE during
  // accept — plausible here, xcodebuild children consume many fds) on a
  // listener-less EventEmitter would escalate to uncaughtException → shutdown.
  httpServer.on('error', (error: Error) => {
    log('error', `[mcp-http] HTTP server error: ${toErrorMessage(error)}`);
  });

  const address = httpServer.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : options.port;

  log(
    'info',
    `[mcp-http] Streamable HTTP transport listening on http://${options.host}:${boundPort}${MCP_ENDPOINT_PATH}`,
  );
  log(
    'info',
    '[mcp-http] Single-session posture: sessionStore (src/utils/session-store.ts) is a module-level singleton, so concurrent MCP sessions would race on session defaults; a new initialize request replaces the previous session. See docs/MCP_HTTP_TRANSPORT_PLAN.md.',
  );
  if (options.sessionTimeoutMs > 0) {
    log('info', `[mcp-http] Idle session timeout: ${options.sessionTimeoutMs} ms`);
  }

  let closed = false;
  return {
    port: boundPort,
    close: async (): Promise<void> => {
      if (closed) {
        return;
      }
      closed = true;
      const openSessions = Array.from(sessions.values());
      sessions.clear();
      await Promise.allSettled(
        openSessions.map((session) => {
          clearIdleTimer(session);
          return session.transport.close();
        }),
      );
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
        // Unblock close() from lingering keep-alive connections; the transports
        // are already closed, so nothing meaningful is left on the wire.
        httpServer.closeAllConnections();
      });
    },
  };
}
