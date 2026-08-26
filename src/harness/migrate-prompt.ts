import * as fs from 'fs';
import * as path from 'path';
import { resolveTemplateFile } from '../utils/paths';
import { writeFileSafe } from '../utils/file-ops';
import { getHarnessDir } from './manifest';
import type { AppliedMigration, MigrationPlan } from './migrations';
import { MIGRATE_BACKUP_DIR, MIGRATE_PLAN_FILE } from './migrations';

export const MIGRATE_PROMPT_FILE = 'MIGRATE-PROMPT.md';

const TARGET_LABEL: Record<string, string> = {
  config: 'harness.env (config)',
  stage: 'stages.json / .har/stages/',
  hook: '.har/hooks/',
  plugin: 'local plugin (.har/plugins/)',
  review: 'review (likely nothing to keep)',
};

function residueTable(plan: MigrationPlan): string[] {
  if (plan.residue.length === 0) {
    return [
      'No adapted-file residue detected — the mechanical migration covers everything.',
      'Skim the backups under `.har/migrate/backup/` once to confirm, then continue with Step 5.',
    ];
  }
  const lines = [
    '| Source | Backup | Lift into | Why |',
    '|--------|--------|-----------|-----|',
  ];
  for (const item of plan.residue) {
    lines.push(
      `| \`${item.source}\` | ${item.backup ? `\`${item.backup}\`` : '—'} | ${TARGET_LABEL[item.target] ?? item.target} | ${item.reason} |`,
    );
  }
  return lines;
}

/**
 * The dynamic section of MIGRATE-PROMPT.md: what maintain detected, what the
 * mechanical migration does (or did), and the residue only an agent can lift.
 */
export function buildMigrationSection(
  plan: MigrationPlan,
  applied: AppliedMigration | null,
): string {
  const lines: string[] = [];

  if (applied) {
    lines.push(
      '## Step 1 — Mechanical migration: DONE',
      '',
      '`har env maintain --migrate` already ran. Every replaced or deleted file is backed up',
      `under \`.har/${MIGRATE_BACKUP_DIR}/\`; the machine-readable plan is \`.har/${MIGRATE_PLAN_FILE}\`.`,
      '',
    );
  } else {
    lines.push(
      '## Step 1 — Run the mechanical migration',
      '',
      '```',
      'har env maintain --migrate',
      '```',
      '',
      'This applies the steps below as code, backing every touched file up under',
      `\`.har/${MIGRATE_BACKUP_DIR}/\` (plan: \`.har/${MIGRATE_PLAN_FILE}\`). Until you run it, the`,
      'vendored pre-1.0 scripts keep working against this CLI (deprecated, not broken).',
      '',
    );
  }

  lines.push(`What the mechanical migration ${applied ? 'did' : 'will do'}:`, '');
  if (plan.replaceWithShims.length > 0) {
    lines.push(
      `- Replace${applied ? 'd' : ''} with managed shims (same argument conventions): ${plan.replaceWithShims.map((f) => `\`${f}\``).join(', ')}`,
    );
  }
  if (plan.deleteMachinery.length > 0) {
    lines.push(
      `- Delete${applied ? 'd' : ''} vendored runtime machinery (now lives in the package): ${plan.deleteMachinery.map((f) => `\`${f}\``).join(', ')}`,
    );
  }
  if ((plan.installMissing ?? []).length > 0) {
    lines.push(
      `- Install${applied ? 'ed' : ''} stock files new in the 1.0 surface: ${plan.installMissing.map((f) => `\`${f}\``).join(', ')}`,
    );
  }
  if (plan.retainMachinery.length > 0) {
    lines.push(
      `- ${applied ? 'Kept' : 'Keep'} (for now) machinery still sourced by your stage/hook scripts: ${plan.retainMachinery.map((f) => `\`${f}\``).join(', ')} — see the residue table`,
    );
  }
  if (plan.env) {
    const env = plan.env;
    const bits: string[] = [];
    if (env.removedFunctions.length > 0) {
      bits.push(`removed shell functions (${env.removedFunctions.join(', ')})`);
    }
    if (env.convertedFlags.length > 0) {
      bits.push(`converted legacy infra flags → \`HARNESS_INFRA_SERVICES="${env.services.join(' ')}"\``);
    }
    if (env.droppedTriplets.length > 0) {
      bits.push(
        env.portLanes
          ? `converted port triplets → \`HARNESS_INFRA_PORT_LANES="${env.portLanes}"\``
          : `dropped ${env.droppedTriplets.length} unused legacy port-triplet exports`,
      );
    }
    if (env.commentedKeys.length > 0) {
      bits.push(`commented out custom keys (${env.commentedKeys.join(', ')})`);
    }
    lines.push(
      `- Rewr${applied ? 'ote' : 'ite'} \`harness.env\` as pure schema-valid config${bits.length > 0 ? `: ${bits.join('; ')}` : ''}`,
    );
  }
  lines.push(
    `- Stamp${applied ? 'ed' : ''} \`manifest.json\` with \`runtimeVersion: ${plan.to}\` and re-baseline${applied ? 'd' : ''} drift checksums`,
    '',
  );

  lines.push('## Step 2 — Residue: adapted files that carry real customization', '');
  lines.push(...residueTable(plan), '');

  return lines.join('\n');
}

function loadTemplate(): string {
  const filePath = resolveTemplateFile('migration-prompt.md');
  if (!filePath) {
    throw new Error('Migration prompt template not found: migration-prompt.md. Run npm run build.');
  }
  return fs.readFileSync(filePath, 'utf8');
}

export function buildMigrationPrompt(plan: MigrationPlan, applied: AppliedMigration | null): string {
  return loadTemplate().replace('{{MIGRATION_SECTION}}', buildMigrationSection(plan, applied));
}

export function writeMigrationPrompt(repoPath: string, content: string): string {
  const filePath = path.join(getHarnessDir(repoPath), MIGRATE_PROMPT_FILE);
  writeFileSafe(filePath, content);
  return filePath;
}
