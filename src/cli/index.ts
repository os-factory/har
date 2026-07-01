import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { envCommand } from './commands/env';
import { controlCommand } from './commands/control';
import { mcpCommand } from './commands/mcp';

export async function runCli(): Promise<void> {
  await yargs(hideBin(process.argv))
    .scriptName('har')
    .usage('$0 <command> [options]')
    .command(envCommand)
    .command(controlCommand)
    .command(mcpCommand)
    .demandCommand(1, 'Please specify a command. Try: har env init')
    .strict()
    .help()
    .version()
    .parse();
}
