import inquirer from 'inquirer';
import {
  TELEMETRY_LEVEL_DESCRIPTIONS,
  type TelemetryLevel,
} from '../core/telemetry-config';

/** Choices for the telemetry depth question, most detailed first. */
export function telemetryLevelChoices(): { name: string; value: TelemetryLevel; short: string }[] {
  return TELEMETRY_LEVEL_DESCRIPTIONS.map((entry) => ({
    name: `${entry.label} — ${entry.summary}`,
    value: entry.level,
    short: entry.label,
  }));
}

export const TELEMETRY_LEVEL_QUESTION =
  'How much agent activity should HAR record? (Cursor / Claude / Codex → local Mission Control, for every repo on this machine)';

export function hqTrajectoryQuestion(orgLabel: string): string {
  return `Also send the full trajectory to HAR HQ (${orgLabel})? Prompts, agent replies and tool output then leave this machine.`;
}

export const HQ_TRAJECTORY_CHOICES = [
  { name: 'No — keep the text local (HQ gets usage and the step outline)', value: false, short: 'No' },
  { name: 'Yes — forward the full trajectory to HQ', value: true, short: 'Yes' },
] as const;

/** Ask whether HQ should receive the full trajectory. Default: no. */
export async function promptHqTrajectory(orgLabel: string, current: boolean): Promise<boolean> {
  const { forward } = await inquirer.prompt<{ forward: boolean }>([
    {
      type: 'list',
      name: 'forward',
      message: hqTrajectoryQuestion(orgLabel),
      choices: [...HQ_TRAJECTORY_CHOICES],
      default: current ? 1 : 0,
    },
  ]);
  return forward;
}
