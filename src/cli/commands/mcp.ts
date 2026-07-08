import type { Argv } from 'yargs';
import { startMcpServer } from '../../server/start-mcp-server.ts';

/**
 * Register the `mcp` command to start the MCP server.
 */
export function registerMcpCommand(app: Argv): void {
  app.command(
    'mcp',
    'Start the MCP server (for use with MCP clients)',
    (yargs) => {
      return yargs
        .option('transport', {
          type: 'string',
          describe: 'Transport to serve MCP over',
          choices: ['stdio', 'http'] as const,
          default: 'stdio' as const,
        })
        .option('port', {
          type: 'number',
          describe: 'Port to listen on (http transport only; 0 picks an ephemeral port)',
          default: 9090,
        })
        .option('host', {
          type: 'string',
          describe: 'Address to bind to (http transport only)',
          default: '127.0.0.1',
        })
        .option('session-timeout-ms', {
          type: 'number',
          describe:
            'Close idle HTTP sessions after this many milliseconds; 0 disables the timeout (http transport only)',
          default: 0,
        });
    },
    async (argv) => {
      await startMcpServer({
        transport: argv.transport,
        port: argv.port,
        host: argv.host,
        sessionTimeoutMs: argv['session-timeout-ms'],
      });
    },
  );
}
