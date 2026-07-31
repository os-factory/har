import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { getHarPackageVersion } from '../core/package-version';
import { ensureDefaultTelemetryPreference } from '../core/telemetry-config';
import { agentsCommand } from './commands/agents';
import { envCommand } from './commands/env';
import { controlCommand } from './commands/control';
import { hooksCommand } from './commands/hooks';
import { mcpCommand } from './commands/mcp';
import { onboardCommand } from './commands/onboard';
import { preferencesCommand } from './commands/preferences';
import { telemetryCommand } from './commands/telemetry';
import { HAR_ROOT_EPILOG } from './help-text';

export async function runCli(): Promise<void> {
  ensureDefaultTelemetryPreference();
  await yargs(hideBin(process.argv))
    .scriptName('har')
    .usage('$0 <command> [options]')
    .command(onboardCommand)
    .command(envCommand)
    .command(agentsCommand)
    .command(controlCommand)
    .command(hooksCommand)
    .command(mcpCommand)
    .command(preferencesCommand)
    .command(telemetryCommand)
    .demandCommand(1, 'Please specify a command. Try: har onboard   or   har env --help')
    .epilog(HAR_ROOT_EPILOG)
    .strict()
    .help()
    .version(getHarPackageVersion())
    .parse();
}
