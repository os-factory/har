import * as fs from 'fs';
import * as path from 'path';
import { resolveTemplatesDir } from '../utils/paths';
import { harnessExists } from './parser';
import { LOCAL_LINES_DIR } from './line-resolve';
import {
  LINE_BUNDLE_KIND,
  LINE_CONTRACT_VERSION,
  LineManifestSchema,
  LineProgramSchema,
  type LineManifest,
  type LineProgram,
} from './schema';

export interface CreateLineOptions {
  id: string;
  title?: string;
  description?: string;
  /** Station ids in order (default: S1, S2). */
  stations?: string[];
  /** Scaffold one registered-but-not-on-verify gate stage (default: true). */
  gateStage?: boolean;
  /** Env var that must be "1" for the gate to run (default: none). */
  optInEnv?: string;
  force?: boolean;
}

export interface CreateLineResult {
  lineId: string;
  lineDir: string;
  filesWritten: string[];
  nextSteps: string[];
}

const LINE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

function renderSkeleton(templatePath: string, tokens: Record<string, string>): string {
  let content = fs.readFileSync(templatePath, 'utf8');
  for (const [token, value] of Object.entries(tokens)) {
    content = content.replace(new RegExp(token, 'g'), value);
  }
  return content;
}

/**
 * Scaffold a project-owned factory line at `.har/lines/<id>/`.
 *
 * The output is a complete, publishable bundle — the same shape
 * `os-factory/har-line` ships (#322) — so `har line add <id>` installs it
 * unchanged and publishing it to npm/git later needs no format change.
 */
export function createLine(repoPath: string, options: CreateLineOptions): CreateLineResult {
  const resolved = path.resolve(repoPath);
  if (!harnessExists(resolved)) {
    throw new Error('No .har/ harness found. Run "har onboard" first.');
  }

  const id = options.id.trim();
  if (!LINE_ID_PATTERN.test(id)) {
    throw new Error(
      `Invalid line id "${id}". Use lowercase letters, digits, dots, dashes (e.g. "onboarding-line").`,
    );
  }

  const lineDir = path.join(resolved, LOCAL_LINES_DIR, id);
  const lineDirRel = `${LOCAL_LINES_DIR}/${id}`;
  if (fs.existsSync(lineDir) && !options.force) {
    throw new Error(`Line already exists: ${lineDirRel}/. Use --force to overwrite.`);
  }

  const stationIds = options.stations?.length ? options.stations : ['S1', 'S2'];
  const title = options.title ?? `${id} factory line`;
  const gateStageId = `${id}-gate`;
  const withGateStage = options.gateStage ?? true;

  const program: LineProgram = LineProgramSchema.parse({
    contractVersion: LINE_CONTRACT_VERSION,
    id,
    title,
    description:
      options.description ??
      'Describe the program: what it produces, and what "done" means at the last station.',
    skills: [{ id: 'factory-line', role: 'orchestrator', install: 'repo:.claude/skills/factory-line' }],
    mcp: [],
    plugins: [],
    stations: stationIds.map((stationId, i) => ({
      id: stationId,
      title: `Station ${i + 1}`,
      description: 'What this station produces.',
      work: { source: 'none', ids: [], optional: true },
    })),
    gate: {
      cumulative: true,
      optInEnv: options.optInEnv ?? null,
      stages: withGateStage
        ? [{ id: gateStageId, fromStation: stationIds[0], tier: 'full' }]
        : [],
    },
    extraStages: withGateStage
      ? [
          {
            id: gateStageId,
            kind: 'test',
            tier: 'full',
            description: `Line-owned gate for ${id} — registered, never on verify`,
          },
        ]
      : [],
    handoff: {
      autonomousShip: false,
      waitFor: 'human review before merge or release',
    },
    prototypeNotes: [],
  });

  const manifest: LineManifest = LineManifestSchema.parse({
    kind: LINE_BUNDLE_KIND,
    id,
    title,
    program: 'line.json',
    files: withGateStage
      ? [{ src: `stages/${gateStageId}.sh`, dest: `.har/stages/${gateStageId}.sh`, executable: true }]
      : [],
    stages: withGateStage
      ? [
          {
            id: gateStageId,
            kind: 'test',
            description: `Line-owned gate for ${id} — registered, never on verify`,
            script: `stages/${gateStageId}.sh`,
            requiresAgentId: true,
            artifacts: [
              {
                path: `.har/artifacts/${gateStageId}`,
                kind: 'directory',
                description: `Artifacts for the ${gateStageId} stage`,
              },
            ],
            tier: 'full',
          },
        ]
      : [],
    nextSteps: [
      `Edit ${lineDirRel}/line.json — name the stations and bind tracker work`,
      ...(withGateStage
        ? [`Edit ${lineDirRel}/stages/${gateStageId}.sh — replace the TODO with the real gate`]
        : []),
      `har line status ${id}`,
      `har line gate ${stationIds[0]} --line ${id}`,
    ],
    docsPath: `${lineDirRel}/README.md`,
  });

  const filesWritten: string[] = [];
  const write = (rel: string, content: string, executable = false): void => {
    const abs = path.join(lineDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    if (executable) fs.chmodSync(abs, 0o755);
    filesWritten.push(`${lineDirRel}/${rel}`);
  };

  write('line.manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
  write('line.json', `${JSON.stringify(program, null, 2)}\n`);

  if (withGateStage) {
    const stageScript = renderSkeleton(
      path.join(resolveTemplatesDir(), 'plugins', 'custom-stage-skeleton.sh'),
      {
        __STAGE_ID__: gateStageId,
        __STAGE_KIND__: 'test',
        __STAGE_DESCRIPTION__: `Line-owned gate for ${id} (not on verify)`,
      },
    );
    write(`stages/${gateStageId}.sh`, stageScript, true);
  }

  write('README.md', renderLineReadme(id, title, stationIds, gateStageId, withGateStage));

  return {
    lineId: id,
    lineDir,
    filesWritten,
    nextSteps: [
      `Edit ${lineDirRel}/line.json — stations, work binding, gate tags`,
      ...(withGateStage
        ? [`Edit ${lineDirRel}/stages/${gateStageId}.sh — replace the TODO with the real gate`]
        : []),
      `Install it: har line add ${id}   (re-run with --force after changes)`,
      `Installing writes .har/ADAPT-PROMPT-line-${id}.md — a ready adaptation prompt for your coding agent`,
      'Publishing later (npm/git) needs zero format changes — see the README',
    ],
  };
}

function renderLineReadme(
  id: string,
  title: string,
  stationIds: string[],
  gateStageId: string,
  withGateStage: boolean,
): string {
  return `# ${title}

A HAR **factory line**: an ordered program of stations plus a cumulative gate.

A line is not a verification plugin. Installing it registers stages but never
adds them to \`verificationStages\` — default \`har env verify --full\` stays
exactly as fast as it was. Line gate stages run on demand:

\`\`\`bash
har line gate ${stationIds[0]} --line ${id}
\`\`\`

If a check should gate *every* verify, it belongs in a verification plugin
(\`har plugin create\` / \`har env add-plugin\`), not here.

## Layout

\`\`\`text
${id}/
├── line.manifest.json   # kind: line — what \`har line add\` applies
├── line.json            # the program: stations, gate, handoff
${withGateStage ? `├── stages/${gateStageId}.sh   # extra gate stage — registered, NOT on verify\n` : ''}└── README.md
\`\`\`

## Stations

${stationIds.map((s, i) => `${i + 1}. \`${s}\``).join('\n')}

## The ratchet

\`gate.stages[].fromStation\` tags a stage as required at that station **and
every later one**. Adding a station must never drop an earlier station's
stages — that is what \`gate.cumulative: true\` means, and it is contract.

## Install channels

\`\`\`bash
har line add ${id}                        # this repo (.har/lines/${id})
har line add ./${id}                      # local path
har line add github:acme/${id}            # git
har line add @acme/${id}                  # npm
\`\`\`

Publishing needs no format change: add a \`package.json\` and push.
`;
}
