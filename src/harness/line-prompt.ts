import * as path from 'path';
import { writeFileSafe } from '../utils/file-ops';
import { getHarnessDir } from './manifest';
import type { LineProgram } from './schema';
import type { ApplyLineResult } from './lines';

/** Per-line adaptation prompt, sibling of ADAPT-PROMPT-<plugin>.md. */
export function lineAdaptationPromptFile(lineId: string): string {
  return `ADAPT-PROMPT-line-${lineId}.md`;
}

/**
 * Post-install prompt for the coding agent.
 *
 * Deliberately does NOT tell the agent to "get full verify green on the new
 * stages": the stages this line registered are off `verify --full` by design
 * and are exercised by `har line gate`. Telling an agent otherwise is how a
 * line quietly becomes a plugin.
 */
export function buildLineAdaptationPrompt(
  repoPath: string,
  program: LineProgram,
  result: ApplyLineResult,
): string {
  const stations = program.stations
    .map((s, i) => `${i + 1}. \`${s.id}\` — ${s.title}${s.work?.ids?.length ? ` (work: ${s.work.ids.join(', ')})` : ''}`)
    .join('\n');

  const gateRows = program.gate.stages
    .map((s) => `| \`${s.id}\` | \`${s.fromStation}\` | ${s.tier} |`)
    .join('\n');

  const registered =
    result.stageIds.length > 0
      ? result.stageIds.map((id) => `- \`${id}\` — registered, **not** in \`verificationStages\``).join('\n')
      : '- _(this line registered no extra stages)_';

  const declaredSkills =
    program.skills.length > 0
      ? program.skills.map((s) => `- \`${s.id}\` (${s.role})${s.install ? ` — install: \`${s.install}\`` : ''}`).join('\n')
      : '- _(none declared)_';

  const declaredMcp =
    program.mcp.length > 0
      ? program.mcp
          .map((m) => `- \`${m.name}\`${m.required ? ' (required)' : ' (optional)'}${m.why ? ` — ${m.why}` : ''}`)
          .join('\n')
      : '- _(none declared)_';

  const warnings =
    result.warnings.length > 0
      ? result.warnings.map((w) => `- ⚠ ${w}`).join('\n')
      : '- _(none)_';

  const optIn = program.gate.optInEnv
    ? `This line's gate is opt-in: stages run only when \`${program.gate.optInEnv}=1\`.`
    : 'This line has no opt-in env var — `har line gate` runs its stages on demand.';

  return `# Adapt the factory line: ${result.lineId}

Installed from \`${result.source}\` into \`${path.basename(path.resolve(repoPath))}\`.
Program: \`${result.programPath}\`

## What just happened

A **factory line** was installed. A line is a *program* — an ordered set of
stations plus a cumulative gate. It is not a verification plugin:

${registered}

\`verificationStages\` was **not** modified. Default \`har env verify --full\`
takes exactly as long as it did before this install. ${optIn}

## Stations

${stations}

## Cumulative gate (the ratchet)

A gate stage tagged \`fromStation: X\` is required at X **and every later
station**. Adding a station must never drop an earlier station's stages.

| Stage | From station | Tier |
|---|---|---|
${gateRows || '| _(none)_ | | |'}

Run it with:

\`\`\`bash
har line gate <station> --line ${result.lineId}
\`\`\`

Never with \`har env verify --full\` — that is the whole point of the split.

## Declared dependencies (declarations, not installs)

Skills:

${declaredSkills}

MCP servers:

${declaredMcp}

HAR does not vendor skill packs or MCP servers. Check they are present, install
them the way your agent normally does, and skip tracker steps for any MCP marked
optional that is missing.

## Warnings from install

${warnings}

## Your job now

1. Read \`${result.programPath}\` and make the stations describe *this* repo's
   work — station titles, \`work.source\`/\`work.ids\`, waves.
2. Make each registered stage script real (replace TODO blocks). They live under
   \`.har/stages/\`.
3. Leave \`gate.cumulative: true\` and \`handoff.autonomousShip: false\` alone —
   both are contract, not preference.
4. Do **not** add line stages to \`verificationStages\`. If a check should gate
   every verify, it belongs in a verification plugin instead
   (\`har env add-plugin\`), not on this line.
5. Verify the harness still passes as before: \`har env verify <slot> --full\`.
`;
}

/** Write the prompt to .har/ADAPT-PROMPT-line-<id>.md; returns the absolute path. */
export function writeLineAdaptationPrompt(
  repoPath: string,
  lineId: string,
  content: string,
): string {
  const filePath = path.join(getHarnessDir(repoPath), lineAdaptationPromptFile(lineId));
  writeFileSafe(filePath, content);
  return filePath;
}
