# MCP HTTP Transport Migration Plan

## Context

Running `test_macos` against the host MCP server from a Linux dev container fails on the full suite: the transport breaks mid-run on slow Swift tests with `Thread.sleep` calls. Per-class scoped runs work.

The current stack is `Docker → HTTP → supergateway (--stateful, --sessionTimeout 900000) → stdio → node build/cli.js mcp → xcodebuild test`. See `scripts/serve-mcp.sh` and `scripts/patch-supergateway.sh`.

## Root cause (three independent layers)

### Layer A — MCP-protocol level

The MCP tool registry path hardcodes `liveProgressEnabled: false` and `streamingFragmentsEnabled: false` for MCP mode (`src/utils/tool-registry.ts:308-315`). The internal fragment pipeline emits `test-discovery`, stage transitions, compiler diagnostics, and process lines, but `createStreamingExecutionContext` (`src/utils/tool-execution-compat.ts:20`) drops them when the flag is off.

Consequence: clients send `_meta.progressToken` (visible in logs, e.g. Claude Code), but the server never replies with `notifications/progress`. Without progress, the client SDK never resets its per-request timer; eventually the HTTP request is cancelled.

The same handler also ignores the second `extra: RequestHandlerExtra` callback argument that the SDK passes — including `extra.signal` (AbortSignal). Client-side cancellation is therefore not propagated to `xcodebuild`.

### Layer B — supergateway bridge

`supergateway` (`stdioToStatefulStreamableHttp.js`):

- Routes `transport.onerror` and `transport.onclose` to `child.kill()` (lines 114-129 of the npx-cached copy). Any HTTP-side disconnect tears down the entire MCP child process for that session.
- `SessionAccessCounter` schedules a `setTimeout(sessionTimeout)` once its counter reaches zero (response finish/close); the callback calls `transport.close()` → `child.kill()`. With the current 15-minute `sessionTimeout`, logs show sessions dying at precisely `+15:01` intervals followed by `MCP shutdown requested: sigterm`.
- `transport.send(jsonMsg)` is called without `await` inside a `forEach` callback (rejected promises previously crashed supergateway as unhandled rejections). The existing `scripts/patch-supergateway.sh` wraps it in `.catch(...)`, which prevents the crash but does not recover the HTTP connection. Late tool responses produce log entries like `Async send failed: No connection established for request ID: N`.

### Layer C — synchronous tool-call duration

`test_macos` invokes `xcodebuild test` as a single-phase command (`src/utils/test-common.ts:185-193`). The full MCP request is held open for the whole test run, with no out-of-band channel for progress, cancellation, or partial results.

## Conceptual solution

Three remediations, each addressing one layer; layers A1 + A2 alone close the immediate failure mode.

| Layer | Remediation | Effect |
| --- | --- | --- |
| A1 | Wire `extra.sendNotification` → `notifications/progress` with throttling and a periodic heartbeat | Client request timer never expires; session counter stays positive; supergateway cleanup timer never starts |
| A2 | Propagate `extra.signal` → `xcodebuild` via `child_process.spawn({ signal, detached: true })` + process-group kill | Client-side cancellation cleanly stops the test run; no orphaned `xcodebuild` |
| B | Replace supergateway with native `StreamableHTTPServerTransport` from `@modelcontextprotocol/sdk` | Removes the "any HTTP error kills the child" pathology; transport lifetime is controlled in-process |
| C (future) | Migrate long-running tools to `registerToolTask` once the experimental MCP Tasks API stabilizes | HTTP requests become short status pings; long execution lives server-side |

## Phased plan

### Stage 1 — Layer A1: progress notifications

1.1 Extend `ToolHandlerContext` (`src/rendering/types.ts`):
- `progressToken?: string | number`
- `sendProgress?: (params: { progress: number; total?: number; message?: string }) => void`
- `signal?: AbortSignal`

1.2 In `src/utils/tool-registry.ts:296-360`, accept the SDK's `extra` argument:
```ts
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerRequest, ServerNotification } from '@modelcontextprotocol/sdk/types.js';
```
Set `liveProgressEnabled: true` and `streamingFragmentsEnabled: true` unconditionally for the MCP path. Pass `extra._meta?.progressToken` and a wrapper around `extra.sendNotification({ method: 'notifications/progress', params: { progressToken, progress, total, message } })` into `ctx`. The wrapper is a no-op when `progressToken === undefined`, so a single code path serves both progress-aware and progress-blind clients.

1.3 New module `src/utils/mcp-progress-bridge.ts`:
- Monotonic `progress` counter (never decreases).
- Throttle: minimum 500 ms between sends, plus a 4-second heartbeat that emits `progress` with the previous counter and `message: "…"` to keep the SSE stream warm even when nothing is happening.
- Fragment → notification mapping:
  - `test-discovery.total` → sets `total`.
  - `stage-transition` / status fragments → `message` + `progress++`.
  - completed/failed/skipped counts → `progress = passed + failed + skipped`.
  - `compiler-diagnostic` (severity `error`) → `message: "N errors so far"`.
  - `process-line` → ignored for notification volume, accumulated for heartbeat freshness only.

1.4 In the MCP handler, wrap `ctx.emit` to also call `bridge.onFragment(fragment)`.

1.5 Verify `Sentry.wrapMcpServerWithSentry` does not turn progress notifications into spans/transactions. If it does, add a span filter.

1.6 Tests:
- Unit (`src/utils/__tests__/mcp-progress-bridge.test.ts`): monotonicity, throttle, heartbeat, fragment filtering.
- Integration: tool call without `progressToken` produces zero notifications.
- `src/test-utils/test-helpers.ts` — new context fields default to undefined / no-op so existing tests stay green.

### Stage 2 — Layer A2: AbortSignal propagation

2.1 Add `signal?: AbortSignal` to `CommandExecOptions` (`src/utils/command.ts`). Opt-in only — never propagated to long-lived sessions:
- log-capture (`utils/log_capture.ts`, `utils/log-capture/*`),
- video-capture (`utils/video_capture.ts`),
- debugger attach (`utils/debugger/*`),
- daemon-side processes (`daemon/*`).

2.2 In the executor, spawn with `{ signal, detached: true }`. On abort:
- `process.kill(-child.pid, 'SIGTERM')` for the process group.
- `Promise.race([on('exit'), setTimeout(KILL_GRACE_MS = 10000)])`.
- If still alive, `process.kill(-child.pid, 'SIGKILL')`.

2.3 In the MCP handler from Stage 1, set `ctx.signal = extra.signal`.

2.4 Pass `ctx.signal` explicitly through `test_macos`, `test_sim`, `test_device`, and `build_run_*` into `executeXcodeBuildCommand`.

2.5 Tests (`src/utils/__tests__/abort-spawn.test.ts`):
- Abort before completion → root `xcodebuild` receives SIGTERM.
- Abort with grandchildren → entire process group dies.
- Log-capture session using the same executor without `signal` is not killed (regression guard).

### Stage 3 — Layer B: native `StreamableHTTPServerTransport`

3.1 Add CLI flags to the `mcp` command:
- `--transport <stdio|http>` (default `stdio`)
- `--port <n>` (default 9090)
- `--host <addr>` (default `127.0.0.1`)
- `--session-timeout-ms <n>` (default 0, disabled)

3.2 New `src/server/start-mcp-http-server.ts`:
- Imports `StreamableHTTPServerTransport` from `@modelcontextprotocol/sdk/server/streamableHttp.js`.
- Uses Node built-in `http.createServer` — no new npm dependency.
- Routes POST/GET/DELETE on `/mcp` to `transport.handleRequest(req, res, body)`.

3.3 Single-session enforcement (MVP):
- A second `initialize` request from a new session-id while another is active responds with JSON-RPC error `-32000 "Server busy: another session active"`.
- Documented as an intentional MVP constraint; multi-session support is a future enhancement requiring per-session session-store via AsyncLocalStorage keyed on `extra.sessionId` (`src/utils/session-store.ts:177` is a module-level singleton today and would need a per-session scope).

3.4 Adapt `src/server/mcp-lifecycle.ts`:
- `attachProcessHandlers({ mode: 'http' | 'stdio' })`.
- In `http` mode: skip `stdin.end/close` and `stdout/stderr` error handlers; keep `SIGTERM`/`SIGINT`/`uncaughtException`/`unhandledRejection`.
- Shutdown sequence: `transport.close()` → `httpServer.close()` (awaited) → `process.exit`.

3.5 `scripts/serve-mcp.sh` body becomes:
```sh
exec node "${PROJECT_ROOT}/build/cli.js" mcp --transport http --port "$PORT"
```
PATH-enrichment and `XCODEBUILDMCP_ENABLED_WORKFLOWS` stay; the script no longer needs PID tracking or process-group signal propagation, since there is exactly one child.

3.6 Move `scripts/patch-supergateway.sh` to `scripts/legacy/patch-supergateway.sh` and keep for one release as a rollback path. Remove all README/docs references.

3.7 Smoke test (`src/smoke-tests/__tests__/mcp-http-transport.test.ts`):
- Use `Client` + `StreamableHTTPClientTransport` from `@modelcontextprotocol/sdk/client/streamableHttp.js`.
- Bring the server up on an ephemeral port, run `initialize` → `tools/list` → `tools/call` with a progress handler.
- Assert progress notifications arrive and the final result lands.
- Negative test: a second concurrent `initialize` is rejected with `-32000`.

### Stage 4 — Documentation and changelog

4.1 `docs/CONFIGURATION.md` — new "HTTP transport for Docker dev environments" section: example `serve-mcp.sh`, the container-side `.mcp.json`, and the single-session MVP constraint.

4.2 README — remove references to `npx supergateway` and `patch-supergateway`.

4.3 `CHANGELOG.md`, under `## [Unreleased]`:
- `### Added`
  - Native HTTP transport for the MCP server (`mcp --transport http`).
  - Progress notifications (`notifications/progress`) for long-running build and test tools.
  - AbortSignal-based cancellation propagated to the `xcodebuild` process group.
- `### Changed`
  - `scripts/serve-mcp.sh` launches the MCP server directly via `StreamableHTTPServerTransport` instead of through a supergateway bridge.
- `### Removed`
  - Supergateway-based HTTP bridge and `scripts/patch-supergateway.sh` (moved to `scripts/legacy/` for one release).

4.4 Run `npm run docs:update` to refresh `TOOLS.md`.

### Stage 5 — Direction, not work

When the experimental MCP Tasks API (`registerToolTask` in `@modelcontextprotocol/sdk/experimental/tasks/*`) stabilizes, migrate `test_macos`, `test_sim`, `test_device`, and `build_run_*` to the task pattern. Stage 1's separation of `*Logic` business logic from registration glue means both registration paths can coexist without touching the cores.

## Sequencing

Stages 1 and 2 are independent and parallelizable. Stage 3 is independent of 1 and 2 but should land after them so the HTTP smoke test exercises the full progress + cancellation path. Stage 4 ships last.

Stage 1 alone is sufficient to unblock the full-suite `test_macos` run on the existing supergateway-based deployment: progress notifications keep `SessionAccessCounter` warm, so the 15-minute cleanup never fires.

Each stage ships as a separate PR. Stage 3 ships behind the `--transport http` flag; `stdio` remains the default so existing deployments are not affected.

## Risk audit (residual)

Audit ran against this plan during design. Twelve risks were identified; eleven are either false positives or routinely solvable at implementation time. The one residual design risk requiring an upfront decision is captured in Stage 3.3 (single-session MVP for the native HTTP transport, since `sessionStore` is a module-level singleton).

## References

- `src/utils/tool-registry.ts:296-360` — current MCP handler registration (no `extra` argument, flags hardcoded false).
- `src/utils/tool-execution-compat.ts` — fragment → MCP context adapter.
- `src/utils/test-common.ts:185-193` — single-phase `xcodebuild test` invocation for macOS.
- `src/server/mcp-lifecycle.ts` — process-level lifecycle handlers.
- `src/server/server.ts:53-65,92-96` — MCP server capabilities and stdio transport binding.
- `src/utils/session-store.ts:177` — singleton session defaults store.
- `scripts/serve-mcp.sh`, `scripts/patch-supergateway.sh` — current supergateway-based bridge.
- `@modelcontextprotocol/sdk` v1.27.1 — provides `StreamableHTTPServerTransport`, `RequestHandlerExtra` (`signal`, `sendNotification`, `_meta`), and experimental Tasks API.
