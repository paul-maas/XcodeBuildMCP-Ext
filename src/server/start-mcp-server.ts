#!/usr/bin/env node

/**
 * MCP Server Startup Module
 *
 * This module provides the logic to start the XcodeBuildMCP server.
 * It can be invoked from the CLI via the `mcp` subcommand.
 */

import { createServer, startServer } from './server.ts';
import { log, setLogLevel } from '../utils/logger.ts';
import { version } from '../version.ts';
import process from 'node:process';
import { bootstrapServer } from './bootstrap.ts';
import { createStartupProfiler, getStartupProfileNowMs } from './startup-profiler.ts';
import { createMcpLifecycleCoordinator } from './mcp-lifecycle.ts';
import { runMcpShutdown } from './mcp-shutdown.ts';

/**
 * Start the MCP server.
 * This function creates and bootstraps the server, sets up signal handlers
 * for graceful shutdown, and starts the server.
 */
export async function startMcpServer(): Promise<void> {
  const lifecycle = createMcpLifecycleCoordinator({
    onShutdown: async ({ reason, error, snapshot, server }) => {
      const transportMessages: Record<string, string> = {
        'stdin-end': 'MCP stdin ended; shutting down MCP server',
        'stdin-close': 'MCP stdin closed; shutting down MCP server',
        'stdout-error': 'MCP stdout pipe broke; shutting down MCP server',
        'stderr-error': 'MCP stderr pipe broke; shutting down MCP server',
      };
      log('info', transportMessages[reason] ?? `MCP shutdown requested: ${reason}`);

      const result = await runMcpShutdown({
        reason,
        error,
        snapshot,
        server,
      });

      lifecycle.detachProcessHandlers();
      process.exit(result.exitCode);
    },
  });

  lifecycle.attachProcessHandlers();

  try {
    const profiler = createStartupProfiler('start-mcp-server');

    // MCP mode defaults to info level logging
    // Clients can override via logging/setLevel MCP request
    setLogLevel('info');

    let stageStartMs = getStartupProfileNowMs();
    lifecycle.markPhase('creating-server');
    const server = createServer();
    lifecycle.registerServer(server);
    profiler.mark('createServer', stageStartMs);

    stageStartMs = getStartupProfileNowMs();
    lifecycle.markPhase('bootstrapping-server');
    const bootstrap = await bootstrapServer(server);
    profiler.mark('bootstrapServer', stageStartMs);

    stageStartMs = getStartupProfileNowMs();
    lifecycle.markPhase('starting-stdio-transport');
    await startServer(server);
    profiler.mark('startServer', stageStartMs);

    lifecycle.markPhase('running');
    const startupSnapshot = await lifecycle.getSnapshot();
    log('info', `[mcp-lifecycle] start ${JSON.stringify(startupSnapshot)}`);
    if (startupSnapshot.anomalies.length > 0) {
      log(
        'warn',
        `[mcp-lifecycle] startup anomalies observed: ${startupSnapshot.anomalies.join(', ')}`,
      );
    }

    lifecycle.markPhase('deferred-initialization');
    void bootstrap
      .runDeferredInitialization({
        isShutdownRequested: () => lifecycle.isShutdownRequested(),
      })
      .catch((error) => {
        log(
          'warn',
          `Deferred bootstrap initialization failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        if (!lifecycle.isShutdownRequested()) {
          lifecycle.markPhase('running');
        }
      });
    log('info', `XcodeBuildMCP server (version ${version}) started successfully`);
  } catch (error) {
    console.error('Fatal error in startMcpServer():', error);
    await lifecycle.shutdown('startup-failure', error);
  }
}
