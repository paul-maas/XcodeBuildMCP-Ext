import type { ToolHandlerContext } from '../rendering/types.ts';
import { DefaultStreamingExecutionContext } from './execution/index.ts';

/**
 * Creates a streaming execution context bridged to a ToolHandlerContext.
 *
 * When `ctx.streamingFragmentsEnabled` is true, domain fragments are forwarded
 * through `ctx.emit(...)` to the render session's fragment handling. When
 * disabled (e.g. MCP, json/raw CLI modes), fragments are silently dropped —
 * the structured-output path captures results at finalization.
 *
 * Only streaming tools (build/test/build-run) should use this adapter.
 * Non-streaming tools should not receive an execution context at all.
 */
export function createStreamingExecutionContext(
  ctx: ToolHandlerContext,
): DefaultStreamingExecutionContext {
  return new DefaultStreamingExecutionContext({
    liveProgressEnabled: ctx.liveProgressEnabled,
    signal: ctx.signal,
    onFragment: ctx.streamingFragmentsEnabled ? (fragment) => ctx.emit(fragment) : undefined,
  });
}

export interface McpProgressPump {
  stop(): void;
}

/**
 * Emits a periodic MCP `notifications/progress` heartbeat for a long-running tool call.
 *
 * MCP tool handlers in this server produce no intermediate protocol traffic until the
 * final response. Over the Docker→host HTTP/SSE transport that silence trips idle
 * watchdogs (the client `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`, default 30s, and a ~165s
 * transport-layer idle drop), aborting the call before it can return. A steady stream of
 * progress notifications keeps every idle timer warm. See docs/MCP_HTTP_TRANSPORT_PLAN.md
 * (Layer A). The counter is monotonic and `total` is intentionally omitted (indeterminate
 * progress). The timer is `unref`'d so it never keeps the process alive on its own, and
 * `stop()` MUST be called when the tool call finishes.
 */
export function startMcpProgressPump(
  sendProgress: (params: { progress: number; total?: number; message?: string }) => void,
  intervalMs = 10_000,
): McpProgressPump {
  let progress = 0;
  const tick = (): void => {
    sendProgress({ progress, message: 'working…' });
    progress += 1;
  };
  // Emit immediately so the SSE stream carries data from t=0, then on a fixed cadence
  // comfortably under the shortest idle timeout.
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return {
    stop(): void {
      clearInterval(timer);
    },
  };
}
