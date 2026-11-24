import { getLineStatus, listInstalledLineIds, runLineGate } from './lines';
import type { VerificationAfterStagesHook, VerificationExtraCheck } from './types';

/**
 * Opt-in factory-line gates after `har env verify` (BE-3795).
 *
 * Line gate stages never join `verificationStages`. Instead, once the verify
 * stages pass, an interactive adapter may offer the installed lines; each one
 * the user picks runs its last station's cumulative gate (= every station),
 * and a failing line fails the verification before it is recorded.
 */

/** One installed line offered after verification. */
export interface VerifyLineChoice {
  lineId: string;
  title: string;
  /** Station whose cumulative gate is run — the line's last station. */
  lastStationId?: string;
  /** First station not green yet; undefined when every station is green. */
  nextStationId?: string;
  allGreen: boolean;
  /** Set when the line's program or status cannot be read; the line cannot run. */
  unreadable?: string;
}

/** Picks which lines to run; an empty array runs none. */
export type VerifyLineChooser = (choices: VerifyLineChoice[]) => Promise<string[]>;

/**
 * Installed line ids, or none when the line files cannot be read (e.g. a
 * malformed line.json). Verify must never fail because of a line nobody chose.
 */
function installedLineIdsOrNone(repoPath: string): string[] {
  try {
    return listInstalledLineIds(repoPath);
  } catch {
    return [];
  }
}

/**
 * Every installed line, with what the chooser needs. A line whose status
 * cannot be read stays listed (marked `unreadable`) so it never hides others.
 */
export function listVerifyLineChoices(repoPath: string): VerifyLineChoice[] {
  return installedLineIdsOrNone(repoPath).map((lineId) => {
    try {
      const status = getLineStatus(repoPath, lineId);
      return {
        lineId,
        title: status.title,
        lastStationId: status.stations[status.stations.length - 1]?.id,
        nextStationId: status.nextStationId,
        allGreen: status.nextStationId === undefined,
      };
    } catch (err: unknown) {
      return {
        lineId,
        title: lineId,
        allGreen: false,
        unreadable: (err as Error).message,
      };
    }
  });
}

/** One-line summary shared by the chooser and the hint. */
export function describeVerifyLineChoice(choice: VerifyLineChoice): string {
  if (choice.unreadable) return `${choice.lineId} — unreadable (see "har line status ${choice.lineId}")`;
  const progress = choice.allGreen ? 'all stations green' : `next: ${choice.nextStationId}`;
  return `${choice.lineId} — ${choice.title}  (${progress})`;
}

/**
 * Hint for non-interactive verify runs, naming the commands of the surface the
 * caller is on; undefined when no line is installed.
 */
export function installedLinesHint(
  repoPath: string,
  surface: 'cli' | 'mcp' = 'cli',
): string | undefined {
  const ids = installedLineIdsOrNone(repoPath);
  if (ids.length === 0) return undefined;
  const noun = ids.length === 1 ? 'line' : 'lines';
  const how =
    surface === 'mcp'
      ? 'See what each checks with har_line_list / har_line_describe; run one with har_run_line_gate.'
      : 'See what each checks with: har line list / har line describe <id>; ' +
        'run one with: har line gate <station> --line <id>';
  return `${ids.length} factory ${noun} installed (${ids.join(', ')}) — not checked by verify. ${how}`;
}

async function runChosenLine(
  repoPath: string,
  agentId: number,
  choice: VerifyLineChoice | undefined,
  lineId: string,
): Promise<VerificationExtraCheck> {
  const name = `line:${lineId}`;
  if (!choice) return { name, pass: false, detail: 'line is not installed' };
  if (choice.unreadable || !choice.lastStationId) {
    return { name, pass: false, detail: choice.unreadable ?? 'line has no stations' };
  }
  try {
    // Picking the line is the opt-in, so the program's optInEnv is bypassed.
    const result = await runLineGate({
      repoPath,
      lineId,
      station: choice.lastStationId,
      agentId,
      force: true,
    });
    if (result.pass) return { name, pass: true };
    const failed = result.stages
      .filter((stage) => stage.status !== 'pass')
      .map((stage) => `${stage.stageId} (from ${stage.fromStation}): ${stage.reason ?? stage.status}`);
    return { name, pass: false, detail: failed.join('; ') };
  } catch (err: unknown) {
    return { name, pass: false, detail: (err as Error).message };
  }
}

/**
 * After-stages hook for `runVerification`: offers the installed lines to
 * `choose`, then runs each chosen line's cumulative gate in the same slot.
 */
export function createVerifyLinesHook(options: {
  repoPath: string;
  agentId: number;
  choose: VerifyLineChooser;
}): VerificationAfterStagesHook {
  return async () => {
    const choices = listVerifyLineChoices(options.repoPath);
    if (choices.length === 0) return [];
    const chosen = [...new Set(await options.choose(choices))];
    const checks: VerificationExtraCheck[] = [];
    for (const lineId of chosen) {
      const choice = choices.find((c) => c.lineId === lineId);
      checks.push(await runChosenLine(options.repoPath, options.agentId, choice, lineId));
    }
    return checks;
  };
}
