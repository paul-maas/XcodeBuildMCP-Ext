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
- `sendProgress?: (params: { progress: number; total?: number; message?: string }) => void` — undefined when the client did not provide a `progressToken`. The closure captures the token so no caller ever handles it directly (single source of truth).
- `signal?: AbortSignal`

1.2 In `src/utils/tool-registry.ts:296-360`, accept the SDK's `extra` argument:
```ts
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerRequest, ServerNotification } from '@modelcontextprotocol/sdk/types.js';
```
Set `streamingFragmentsEnabled: true` for the MCP path — this is the flag that actually gates fragment forwarding (`src/utils/tool-execution-compat.ts:20`). Leave `liveProgressEnabled: false`: it is an independent CLI-rendering signal and turning it on in MCP mode would activate terminal-oriented paths in `renderCliTextRenderer`. When `extra._meta?.progressToken !== undefined`, build `sendProgress` as a closure that captures the token and forwards to `extra.sendNotification({ method: 'notifications/progress', params: { progressToken, progress, total, message } })`. When the token is absent, leave `ctx.sendProgress` undefined so callers explicitly `?.()` it. One code path either way.

1.3 Add the bridging logic **inline** in `src/utils/tool-execution-compat.ts` — a `createFragmentToProgressBridge(sendProgress)` function that returns a fragment handler. Not a separate module: the consumer is one, and CLAUDE.md forbids abstractions beyond need.

Bridge state:
- Monotonic `progress` counter (never decreases).
- Throttle: minimum 500 ms between sends.
- Heartbeat: 4-second `setInterval` emits `progress` with the previous counter and `message: "…"` to keep the SSE stream warm during silent stretches.
- Timer lifecycle: heartbeat starts on first fragment and stops via `clearInterval` when the pipeline reports finalization or `ctx.signal` aborts. Never leaks past the tool call.

Fragment mapping uses the `{ kind, fragment }` two-level discrimination declared in `src/types/domain-fragments.ts`:
- `kind: 'test-result'`, `fragment: 'test-discovery'` → sets `total` from `.total`.
- `kind: 'test-result'` with running counts → `progress = passed + failed + skipped`.
- `kind: 'infrastructure'`, `fragment: 'status'` → `message` + `progress++`.
- `kind: 'compiler'`, `fragment: 'compiler-diagnostic'`, `severity: 'error'` → `message: "N errors so far"`.
- `kind: 'transcript'` (`process-command`, `process-line`) → ignored for notification volume; only bumps a heartbeat-freshness marker so silent runs still get their heartbeat.

1.4 In the MCP handler in `tool-registry.ts`, when `ctx.sendProgress` is set: construct the bridge via `createFragmentToProgressBridge(ctx.sendProgress)` and wrap `ctx.emit` to call the bridge handler in addition to the existing `session.emit(fragment)`.

1.5 Tests:
- Unit (extend the existing `src/utils/__tests__/tool-execution-compat.test.ts` or equivalent): monotonicity, throttle, heartbeat lifecycle (starts on first fragment, cleared on finalize/abort), fragment filtering.
- Integration: tool call without `progressToken` — `ctx.sendProgress` undefined — produces zero notifications.
- `src/test-utils/test-helpers.ts` — new context fields default to undefined / no-op so existing tests stay green.

1.6 Deactivation (not removal) of `scripts/patch-supergateway.sh`: with progress notifications flowing, the client's request timer never expires, so the late-send race the patch guards against no longer occurs. Mark the script as no longer required in a header comment but leave the file in place as a safety net. Physical retirement happens in Stage 3.6. Zero runtime change in Stage 1.

### Stage 2 — Layer A2: AbortSignal propagation

2.1 Extend `CommandExecOptions` in `src/utils/CommandExecutor.ts` with two new fields:
- `signal?: AbortSignal`
- `processGroup?: boolean` — when true, spawn the child in its own process group so a single `process.kill(-pid, ...)` reaches every descendant.

Kept **separate** from the existing positional `detached` parameter of `CommandExecutor`, which has an unrelated "when does the promise resolve" semantics (see the type comment in `CommandExecutor.ts`). Overloading `detached` would silently break the existing contract that `execution` tests rely on.

Both options are opt-in only — never propagated to long-lived sessions:
- log-capture (`utils/log_capture.ts`, `utils/log-capture/*`),
- video-capture (`utils/video_capture.ts`),
- debugger attach (`utils/debugger/*`),
- daemon-side processes (`daemon/*`).

2.2 In `defaultExecutor` in `src/utils/command.ts:68-89` (the sole spawn point of the default executor), extend `spawnOpts` when the new options are set: `spawnOpts.signal = opts.signal`; `spawnOpts.detached = opts.processGroup === true`. On abort:
- `process.kill(-child.pid, 'SIGTERM')` for the process group.
- `Promise.race([on('exit'), setTimeout(KILL_GRACE_MS = 10000)])`.
- If still alive, `process.kill(-child.pid, 'SIGKILL')`.
- Note: `xcodebuild` catches SIGTERM and runs its own cleanup; 10 s is a starting grace period, revisit if flake logs show truncated `xcresult`.

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

3.3 Single-session posture (documented, not enforced in code):
- The stated use case is one dev container ↔ one host MCP. Do not add code enforcement of "one active session at a time" — it is out-of-scope YAGNI for the actual user and adds a rejection path plus a negative smoke test that would exist only to test the rejection itself.
- Documented in `docs/CONFIGURATION.md` and logged at server start: "single-session posture: `sessionStore` (`src/utils/session-store.ts:177`) is a module-level singleton, so concurrent MCP sessions will race on session defaults. Not currently supported."
- Multi-session support is a future enhancement requiring per-session session-store via AsyncLocalStorage keyed on `extra.sessionId`. Left as a TODO comment adjacent to the singleton, with a link to this document.

3.4 Adapt `src/server/mcp-lifecycle.ts`:
- `attachProcessHandlers({ mode: 'http' | 'stdio' })`.
- In `http` mode: skip `stdin.end/close` and `stdout/stderr` error handlers; keep `SIGTERM`/`SIGINT`/`uncaughtException`/`unhandledRejection`.
- Shutdown sequence: `transport.close()` → `httpServer.close()` (awaited) → `process.exit`.

3.5 `scripts/serve-mcp.sh` body becomes:
```sh
exec node "${PROJECT_ROOT}/build/cli.js" mcp --transport http --port "$PORT"
```
PATH-enrichment and `XCODEBUILDMCP_ENABLED_WORKFLOWS` stay. `exec` replaces the shell with `node`, so the existing `cleanup` trap (PID-file removal) will not run. Two decisions to make at implementation time:
- **Preferred**: drop the PID file entirely. With `exec`, there is exactly one process; whoever started the script (systemd, launchd, tty) owns SIGTERM propagation directly. No external tooling in this repo reads `logs/mcp-server-${PORT}.pid`.
- **Fallback**, only if an external consumer of that PID file surfaces: move creation and cleanup into the Node CLI in `registerMcpCommand` (write on transport ready, `process.on('exit', ...)` to remove).

3.6 Move `scripts/patch-supergateway.sh` (already inert since Stage 1.6) to `scripts/legacy/patch-supergateway.sh` and keep for one release as a rollback path. Remove all README/docs references.

3.7 Smoke test (`src/smoke-tests/__tests__/mcp-http-transport.test.ts`):
- Use `Client` + `StreamableHTTPClientTransport` from `@modelcontextprotocol/sdk/client/streamableHttp.js`.
- Bring the server up on an ephemeral port, run `initialize` → `tools/list` → `tools/call` with a progress handler.
- Assert progress notifications arrive and the final result lands.

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

Stage 1 alone is sufficient to unblock the full-suite `test_macos` run on the existing supergateway-based deployment: progress notifications keep `SessionAccessCounter` warm, so the 15-minute cleanup never fires. `scripts/patch-supergateway.sh` becomes dead code from Stage 1.6 onward and is physically retired in Stage 3.6.

Each stage ships as a separate PR. Stage 3 ships behind the `--transport http` flag; `stdio` remains the default so existing deployments are not affected.

## Risk audit (residual)

Audit ran against this plan during design. Twelve risks were identified; eleven are either false positives or routinely solvable at implementation time. The one residual design risk requiring an upfront decision is captured in Stage 3.3 (single-session MVP for the native HTTP transport, since `sessionStore` is a module-level singleton).

## References

- `src/utils/tool-registry.ts:296-360` — current MCP handler registration (no `extra` argument, flags hardcoded false).
- `src/utils/tool-execution-compat.ts` — fragment → MCP context adapter; also the host for the new `createFragmentToProgressBridge`.
- `src/types/domain-fragments.ts` — `{ kind, fragment }` two-level fragment discrimination that the bridge maps over.
- `src/utils/test-common.ts:185-193` — single-phase `xcodebuild test` invocation for macOS.
- `src/utils/CommandExecutor.ts` — target for the new `signal` and `processGroup` fields on `CommandExecOptions`.
- `src/utils/command.ts:68-89` — sole point of `spawn(...)` in the default executor.
- `src/server/mcp-lifecycle.ts` — process-level lifecycle handlers.
- `src/server/server.ts:53-65,92-96` — MCP server capabilities and stdio transport binding.
- `src/utils/session-store.ts:177` — singleton session defaults store (single-session posture reason).
- `scripts/serve-mcp.sh`, `scripts/patch-supergateway.sh` — current supergateway-based bridge.
- `@modelcontextprotocol/sdk` v1.27.1 — provides `StreamableHTTPServerTransport`, `RequestHandlerExtra` (`signal`, `sendNotification`, `_meta`), and experimental Tasks API.
