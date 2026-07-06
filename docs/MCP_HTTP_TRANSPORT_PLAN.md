# MCP HTTP Transport Migration Plan

## Context

Running a full `test_macos` suite against the host MCP server from a Linux dev container failed: the run either got killed early or completed but never delivered its result. Per-class scoped runs worked (short enough to dodge the timeouts).

The current stack is `Docker → HTTP → supergateway (--stateful, --sessionTimeout 900000) → stdio → node build/cli.js mcp → xcodebuild test`. See `scripts/serve-mcp.sh` and `scripts/patch-supergateway.sh`.

## Status (as of 2026-07)

The full monolithic `test_macos` run now completes and delivers its structured result end-to-end (validated live: ~13 KB payload, `diagnostics.errors: 0`, 35 real test failures, 1697 discovered). Shipped so far:

- ✅ **Layer D — response size** (commits `5a648d6b`, `28390526`): capped `tests.selected`; stopped misclassifying os_log as build errors. Details under "Layer D" below.
- ✅ **Layer A1 — progress heartbeat** (commit `29e7f077`): server emits `notifications/progress` so the transport's idle timers stay warm. Details in Stage 1.
- ✅ **Interim supergateway progress-routing patch** (commit `adbf92e9`): routes progress to the request's stream so the response connection survives. Details under "Interim supergateway patch". **This is a workaround, not the fix.**

Remaining (this document):

- ⏳ **Stage 3 — Layer B** (native `StreamableHTTPServerTransport`, remove supergateway): the real root-cause fix. Deletes the need for both supergateway patches. **Next major work; best done in a fresh context using this doc as the spec.**
- ⏳ **Stage 2 — Layer A2** (AbortSignal → `xcodebuild` process-group kill): reordered to **after** Stage 3. It is no longer urgent (the heartbeat means runs complete instead of dying mid-run, so idle-drop orphans no longer occur), and it is cleaner to build on Layer B's well-defined cancellation signal than on supergateway's `child.kill()` semantics.

## Root cause (three independent layers)

_Original diagnosis — retrospective. Layers A1 and D are now fixed (see Status); the file:line references below reflect the pre-fix code._

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

### Layer D — unbounded response size (fixed)

Separate from the transport, the tool's `structuredContent` was unbounded and grew with test count. Measured on a real run: `tests.selected` serialized the full resolved selector list (1540 entries = 157 KB for a 28-test result), and `diagnostics.errors` captured app/xcodebuild os_log lines misclassified as build errors (472 entries = 78 KB structured + ~70 KB duplicated into the rendered text). Both are now fixed:
- `tests.selected` capped at `MAX_SELECTED_TESTS = 100`, count preserved in `discovered.total` (`src/utils/xcodebuild-domain-results.ts`, commit `5a648d6b`).
- `isBuildErrorDiagnosticLine` rejects `Process[pid:tid]` runtime-log lines before the loose `error:` match (`src/utils/xcodebuild-line-parsers.ts`, commit `28390526`).

Necessary but **not sufficient** on its own — a silent run died before reaching the response phase. Now validated end-to-end once Layer A1 + progress routing let a run deliver: the live full-suite result was ~13 KB with `diagnostics.errors: 0`.

## Empirical validation findings (2026-07)

A live container→host run confirmed the layer priority:

1. **Layer A is the proximate blocker.** The client idle-watchdog `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` (unit **milliseconds**, default **30000 = 30 s**, `0` disables) aborts any MCP tool call that emits no notification for 30 s. With no server-side progress, every silent `test_macos` dies at 30 s. Disabling it let the run survive to ~165 s, where a **second, transport-layer idle drop** fired (`"transport dropped mid-call"`), attributed to the container→host:9090 path (Docker Desktop NAT and/or the container firewall) closing the silent SSE stream. Disabling client timeouts is whack-a-mole; only server-side progress (Layer A) keeps *all* idle timers warm.
2. **Layer A2 confirmed.** When the session died, the `xcodebuild` subtree was orphaned on the host (reparented to launchd), plus a leaked test-host app and MCP child — exactly the cancellation gap A2 addresses.
3. **Earlier "300 s idle" framing was wrong.** The real client default is 30 s (ms). The host-side Node `requestTimeout` (default 300 s) governs request receipt, not the response, and never fired.
4. **Layer A1 works, but supergateway broke delivery.** With the heartbeat shipped, a full run survived build + test to completion (~565 s, 3.4× past the old 165 s death) — the idle-abort is gone. But the result was then lost: `Async send failed: No connection established for request ID: N`. Cause: supergateway forwards child notifications with **no `relatedRequestId`**, so the heartbeat's `notifications/progress` land on the standalone GET SSE stream (which keeps the client watchdog happy) while the request's POST **response** connection gets no keep-alive traffic and is idle-dropped — so the completed result cannot be delivered.
5. **Interim patch confirmed the diagnosis.** Patching supergateway to forward progress with `relatedRequestId = params.progressToken` (Claude Code sets `progressToken == id`) reunited the heartbeat with the response connection; the next full run delivered its result cleanly (Status section). This request↔notification association is exactly what a native transport (Stage 3) provides for free — motivating Layer B beyond the original "any HTTP error kills the child" reason.

### Separate issue — helper daemon code-signing race (not a transport problem)

The specific validation run was pathologically silent (258 s) because the app-under-test hung on its privileged helper. Root cause (from `launchd`/kernel logs): the helper `LaunchDaemon` binary in the shared `~/Library/Developer/XcodeBuildMCP/DerivedData` was rewritten by a second incremental `test_macos` run without refreshing its ad-hoc signature (`cs_mtime != mtime`, delta = the 17 min between the two runs), so the kernel's `AppleSystemPolicy`/AMFI rejected the demand-launch (`load code signature error 2`). launchd retried and the daemon came up ~10 s later, but the app's `HelperManager` watchdog (~6 s) had already given up. Mitigation: clean the MCP DerivedData before a run, or avoid back-to-back `test_macos` against the same DerivedData. Orthogonal to the transport work, but it is what exposed the transport idle timeout in that run.

## Conceptual solution

Remediations by layer. In practice a working end-to-end path today needs **Layer D** (bounded response) + **Layer A1** (heartbeat) + **request-scoped progress routing** — the last via the interim supergateway patch now, permanently via Layer B. A2 is orphan cleanup; C is the long-term direction.

| Layer | Remediation | Effect | Status |
| --- | --- | --- | --- |
| D | Cap `tests.selected`; keep os_log out of `diagnostics.errors` | Response stays small (~13 KB, `errors: 0`) | ✅ done |
| A1 | `extra.sendNotification` → periodic `notifications/progress` heartbeat | Client idle-watchdog (30 s) and transport idle (~165 s) stay warm; run survives to completion | ✅ done |
| — | Route progress with `relatedRequestId` so it rides the request's response stream | Completed result is actually deliverable (not lost on a dead idle connection) | ✅ interim patch; free under Layer B |
| B | Replace supergateway with native `StreamableHTTPServerTransport` | Removes "any HTTP error kills the child" **and** the request↔notification association loss; deletes both supergateway patches | ⏳ Stage 3 |
| A2 | Propagate `extra.signal` → `xcodebuild` process-group kill | Cancellation cleanly stops the run; no orphaned `xcodebuild` | ⏳ after Stage 3 |
| C (future) | Migrate long-running tools to `registerToolTask` (experimental Tasks API) | HTTP requests become short status pings; long execution lives server-side | later |

## Phased plan

### Stage 1 — Layer A1: progress heartbeat — ✅ DONE (commit `29e7f077`)

Shipped as a simple heartbeat, deliberately **simpler** than the fragment-mapping bridge originally sketched here (that richer design is kept under "Deferred" in 1.5).

1.1 `ToolHandlerContext` (`src/rendering/types.ts`) gained:
- `sendProgress?: (params: { progress: number; total?: number; message?: string }) => void` — set only when the client supplied a `progressToken`; the closure captures the token (single source of truth), so no caller handles it directly.
- `signal?: AbortSignal` — carries `extra.signal`, plumbed for Stage 2 (not yet consumed).

1.2 The MCP tool registration (`src/utils/tool-registry.ts`) now takes the SDK's `extra` argument (its type is inferred from `registerTool`'s callback — no explicit import, no `any`). When `extra._meta?.progressToken !== undefined`, `ctx.sendProgress` forwards to `extra.sendNotification({ method: 'notifications/progress', params: { progressToken, ... } })` (fire-and-forget with `.catch`). `streamingFragmentsEnabled` is left **false** (and `liveProgressEnabled` false): the heartbeat alone defeats the idle drops **without** routing pipeline fragments into the rendered response, so tool output and snapshot fixtures are unchanged. This is the key simplification over the original design.

1.3 `startMcpProgressPump(sendProgress, intervalMs = 10_000)` in `src/utils/tool-execution-compat.ts`: emits an immediate progress at t=0, then a monotonic-counter heartbeat every 10 s (comfortably under the 30 s client watchdog). `total` is omitted (indeterminate progress). The timer is `unref`'d and `stop()` is called in the handler's `finally`, so it never leaks past the tool call. No fragment mapping — a fixed-cadence tick is enough to keep the stream warm.

1.4 Tests: `src/utils/__tests__/tool-execution-compat.test.ts` (immediate tick, monotonic cadence, `stop()` halts further sends). Existing suites stayed green; `src/test-utils/test-helpers.ts` needed no change because the new context fields are optional.

1.5 **Deferred (not built): fragment-based progress.** The original design mapped pipeline fragments (`test-discovery` → `total`, `test-progress` → `progress`, `compiler-diagnostic` → `message`) for meaningful progress numbers. That requires `streamingFragmentsEnabled: true`, which routes those fragments into the rendered response and changes snapshot fixtures. Deferred as a future enhancement — the plain heartbeat is sufficient to keep the transport warm, which is the whole point of Layer A.

1.6 **Correction to the original plan:** the heartbeat did **not** make `scripts/patch-supergateway.sh` dead code. Validation (findings 4–5) showed supergateway needs an **additional** patch — routing progress via `relatedRequestId` — before the response is deliverable. Both supergateway patches are live and required until Stage 3 removes supergateway. See "Interim supergateway patch" below.

### Interim supergateway patch — ✅ DONE (commit `adbf92e9`)

`scripts/patch-supergateway.sh` now applies two edits to the npx-cached stateful streamable-HTTP gateway:
1. **Async send** (pre-existing): wrap `transport.send(jsonMsg)` in `.catch()` so rejected sends don't crash the process.
2. **Progress routing** (new): forward `notifications/progress` with `relatedRequestId = params.progressToken`, so the heartbeat lands on the request's POST response stream instead of the standalone GET stream. Without it the response connection is idle-dropped and the result is undeliverable (findings 4–5).

Both are **interim workarounds**. Stage 3 (native transport) removes supergateway and deletes this script — a native `StreamableHTTPServerTransport` associates request-scoped notifications with their stream automatically, so neither patch is needed.

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

2.3 `ctx.signal = extra.signal` is already wired in the Stage 1 MCP handler (`ToolHandlerContext.signal`); Stage 2 only needs to consume it — no handler change required here.

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

3.6 Move `scripts/patch-supergateway.sh` (still active until this stage — both the async-send and progress-routing patches) to `scripts/legacy/patch-supergateway.sh` once the native transport replaces supergateway, and keep for one release as a rollback path. Remove all README/docs references.

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

Stage 1 (progress heartbeat) **plus** the interim progress-routing patch together unblock the full-suite `test_macos` run — confirmed empirically (see "Empirical validation findings" and Status). The proximate killers are silence-driven idle timeouts — the client `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` at 30 s and a ~165 s transport-layer idle drop on the container→host path — **not** supergateway's 15-minute `SessionAccessCounter` cleanup. The heartbeat keeps the streams warm so no idle timer fires; the routing patch ensures the completed result rides a warm connection instead of a dead one. Reaching the response phase is also the only way the Layer D size fix (already shipped) gets exercised end-to-end. Stage 3 replaces both supergateway patches with a native transport that does this correctly by construction; `scripts/patch-supergateway.sh` is retired in Stage 3.6.

Each stage ships as a separate PR. Stage 3 ships behind the `--transport http` flag; `stdio` remains the default so existing deployments are not affected.

## Risk audit (residual)

Audit ran against this plan during design. Twelve risks were identified; eleven are either false positives or routinely solvable at implementation time. The one residual design risk requiring an upfront decision is captured in Stage 3.3 (single-session MVP for the native HTTP transport, since `sessionStore` is a module-level singleton).

## References

- `src/utils/tool-registry.ts` — MCP handler registration; now takes the SDK `extra`, builds `ctx.sendProgress`, and runs the heartbeat pump (commit `29e7f077`). `streamingFragmentsEnabled`/`liveProgressEnabled` remain false.
- `src/utils/tool-execution-compat.ts` — MCP context adapter; host of `startMcpProgressPump` (the shipped heartbeat) and `createStreamingExecutionContext`.
- `src/types/domain-fragments.ts` — `{ kind, fragment }` two-level fragment discrimination (input to the deferred fragment-based progress in Stage 1.5).
- `src/utils/test-common.ts:185-193` — single-phase `xcodebuild test` invocation for macOS.
- `src/utils/CommandExecutor.ts` — target for the new `signal` and `processGroup` fields on `CommandExecOptions`.
- `src/utils/command.ts:68-89` — sole point of `spawn(...)` in the default executor.
- `src/server/mcp-lifecycle.ts` — process-level lifecycle handlers.
- `src/server/server.ts:53-65,92-96` — MCP server capabilities and stdio transport binding.
- `src/utils/session-store.ts:177` — singleton session defaults store (single-session posture reason).
- `scripts/serve-mcp.sh`, `scripts/patch-supergateway.sh` — current supergateway-based bridge; the patch script applies two edits (async-send + progress routing via `relatedRequestId`), both retired by Stage 3.
- `@modelcontextprotocol/sdk` v1.27.1 — provides `StreamableHTTPServerTransport`, `RequestHandlerExtra` (`signal`, `sendNotification`, `_meta`), and experimental Tasks API.
