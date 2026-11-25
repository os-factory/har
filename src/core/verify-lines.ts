import { listLines, type LineRunAll } from './lines';

/**
 * Factory lines as an optional next step after `har env verify` (BE-3795).
 *
 * Verify never runs a line and never asks which one to run: a TTY does not tell
 * a human from an agent driving a PTY, so a prompt would hang agents. Instead
 * every surface (text, --json, MCP) lists the installed lines with the command
 * that runs each one against the slot that was just verified.
 */

/** One installed line offered as a next step. */
export interface VerifyNextStepLine {
  lineId: string;
  title: string;
  stationIds: string[];
  /** First station that is not green; undefined when every station is green. */
  nextStationId?: string;
  allGreen: boolean;
  /** Runs every station (the last station's cumulative gate) in the verified slot. */
  runAll: LineRunAll;
}

/**
 * Installed lines that can be run, with commands targeting `agentId`. Lines
 * that cannot be read are left out (`har line list` shows them). Never throws:
 * a broken line must not break verify.
 */
export function verifyLinesNextStep(repoPath: string, agentId: number): VerifyNextStepLine[] {
  let installed;
  try {
    installed = listLines(repoPath, { agentId }).installed;
  } catch {
    return [];
  }
  return installed.flatMap((line) =>
    line.unreadable || !line.runAll
      ? []
      : [
          {
            lineId: line.lineId,
            title: line.title,
            stationIds: line.stationIds,
            nextStationId: line.nextStationId,
            allGreen: line.allGreen,
            runAll: line.runAll,
          },
        ],
  );
}
