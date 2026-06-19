import type { Argv } from 'yargs';
import { runHarMcpServer } from '../../mcp/server';

export const mcpCommand = {
  command: 'mcp',
  describe: 'Start the HAR MCP server (stdio transport)',
  builder: (yargs: Argv) =>
    yargs.option('repo', {
      type: 'string',
      default: '.',
      describe: 'Default repository path when tools omit repo',
    }),
  handler: async (argv: { repo: string }) => {
    await runHarMcpServer(argv.repo);
  },
};
