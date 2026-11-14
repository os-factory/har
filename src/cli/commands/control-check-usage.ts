import type { Argv } from 'yargs';
import { getControlApiUrl } from '../../core/control-config';
import { canonicalizeControlRepoPath } from '../../core/control-repo-path';
import {
  fetchUsageInvariantReport,
  formatUsageInvariantReport,
} from '../../core/usage-invariants-check';
import { error, header, info, success, warn } from '../../utils/logging';
import { finishCommand } from '../finish-command';

export function checkUsageOptions(y: Argv): Argv {
  return y
    .option('repo', {
      type: 'string',
      describe:
        'Only violations touching this repository (path or Mission Control id); default: all',
    })
    .option('api-url', { type: 'string', describe: 'Control API URL' })
    .option('json', { type: 'boolean', default: false })
    .option('limit', {
      type: 'number',
      default: 20,
      describe: 'Violations to print (text output)',
    });
}

const MISSION_CONTROL_ID = /^[0-9a-f-]{36}$/i;

/**
 * `har control check-usage` — read-only: Mission Control checks the usage
 * invariants over what it holds and would ship to HAR HQ. Exits 1 on any
 * violation, 2 when the check cannot run.
 */
export async function handleCheckUsage(argv: {
  repo?: string;
  apiUrl?: string;
  json: boolean;
  limit: number;
}): Promise<void> {
  const repo =
    argv.repo && !MISSION_CONTROL_ID.test(argv.repo)
      ? canonicalizeControlRepoPath(argv.repo)
      : argv.repo;
  try {
    const report = await fetchUsageInvariantReport(argv.apiUrl ?? getControlApiUrl(), repo);
    if (argv.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    } else {
      header('har control check-usage');
      for (const line of formatUsageInvariantReport(report, argv.limit)) info(line);
      if (report.ok) success('Usage invariants hold.');
      else if (report.blockedUnits.length > 0)
        warn(
          `\`har control sync\` leaves ${report.blockedUnits.length} session(s) counted twice out of the HQ post until fixed.`,
        );
    }
    if (!report.ok) return finishCommand(1);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (argv.json)
      process.stdout.write(JSON.stringify({ ok: false, error: message }, null, 2) + '\n');
    else error(`Usage check failed: ${message}`);
    return finishCommand(2);
  }
}
