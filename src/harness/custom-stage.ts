import * as fs from 'fs';
import * as path from 'path';
import { resolveTemplatesDir } from '../utils/paths';
import { harnessExists } from './parser';
import {
  HarnessStage,
  HarnessStageKind,
  HarnessStageKindSchema,
  HarnessStageSchema,
} from './schema';
import { readStageRegistry, writeStageRegistry } from './stages';

export interface AddCustomStageOptions {
  id: string;
  kind?: HarnessStageKind;
  /** Shell command with optional {agentId} substitution. Mutually exclusive with script. */
  command?: string;
  /** Scaffold .har/stages/<id>.sh from the contract skeleton. Mutually exclusive with command. */
  script?: boolean;
  description?: string;
  /** Include the stage in verify --full via stages.json verificationStages. */
  verification?: boolean;
  force?: boolean;
}

export interface AddCustomStageResult {
  stageId: string;
  kind: HarnessStageKind;
  mode: 'command' | 'script';
  filesWritten: string[];
  verification: boolean;
  nextSteps: string[];
}

const STAGE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export function addCustomStage(
  repoPath: string,
  options: AddCustomStageOptions,
): AddCustomStageResult {
  const resolved = path.resolve(repoPath);
  if (!harnessExists(resolved)) {
    throw new Error('No .har/ harness found. Run "har env init" first.');
  }

  const id = options.id.trim();
  if (!STAGE_ID_PATTERN.test(id)) {
    throw new Error(
      `Invalid stage id "${id}". Use lowercase letters, digits, dots, dashes (e.g. "unit-tests").`,
    );
  }

  const kind = options.kind ?? 'custom';
  if (!HarnessStageKindSchema.options.includes(kind)) {
    throw new Error(
      `Invalid stage kind "${kind}". Available: ${HarnessStageKindSchema.options.join(', ')}`,
    );
  }

  if (Boolean(options.command) === Boolean(options.script)) {
    throw new Error(
      'Choose exactly one execution mode: --command "<shell command>" for a one-liner, or --script to scaffold .har/stages/<id>.sh.',
    );
  }

  const registry = readStageRegistry(resolved);
  const existing = registry.stages.find((s) => s.id === id);
  if (existing && !options.force) {
    throw new Error(`Stage "${id}" already registered in .har/stages.json. Use --force to replace.`);
  }

  const filesWritten: string[] = [];
  const stage: Record<string, unknown> = {
    id,
    kind,
    description: options.description ?? `Custom ${kind} stage`,
    requiresAgentId: true,
    artifacts: [],
  };

  if (options.command) {
    stage.command = options.command;
  } else {
    const scriptRel = path.join('stages', `${id}.sh`);
    const scriptAbs = path.join(resolved, '.har', scriptRel);
    if (fs.existsSync(scriptAbs) && !options.force) {
      throw new Error(`Stage script already exists: .har/${scriptRel}. Use --force to overwrite.`);
    }
    const skeletonPath = path.join(
      resolveTemplatesDir(),
      'plugins',
      'custom-stage-skeleton.sh',
    );
    const skeleton = fs
      .readFileSync(skeletonPath, 'utf8')
      .replace(/__STAGE_ID__/g, id)
      .replace(/__STAGE_KIND__/g, kind)
      .replace(/__STAGE_DESCRIPTION__/g, stage.description as string);
    fs.mkdirSync(path.dirname(scriptAbs), { recursive: true });
    fs.writeFileSync(scriptAbs, skeleton);
    fs.chmodSync(scriptAbs, 0o755);
    filesWritten.push(`.har/${scriptRel}`);
    stage.script = scriptRel;
    stage.artifacts = [
      {
        path: `.har/artifacts/${id}`,
        kind: 'directory',
        description: `Artifacts for the ${id} stage`,
      },
    ];
  }

  const parsedStage: HarnessStage = HarnessStageSchema.parse(stage);
  const stages = existing
    ? registry.stages.map((s) => (s.id === id ? parsedStage : s))
    : [...registry.stages, parsedStage];

  const verification = options.verification ?? false;
  const verificationStages = [...(registry.verificationStages ?? [])];
  if (verification && !verificationStages.includes(id)) {
    verificationStages.push(id);

    const verifyIdx = stages.findIndex((s) => s.id === 'verify');
    if (verifyIdx >= 0) {
      stages[verifyIdx] = {
        ...stages[verifyIdx],
        description: `Verification pipeline (quick smoke by default; --full runs the registry's verificationStages: ${verificationStages.join(', ')})`,
      };
    }
  }

  writeStageRegistry(resolved, { ...registry, stages, verificationStages });
  filesWritten.push('.har/stages.json');

  const nextSteps = options.command
    ? [
        `Try it: ${options.command.replace(/\{agentId\}/g, '1')}`,
        `Agents run it via the MCP tool har_run_stage (stageId: "${id}")`,
        ...(verification ? ['./.har/verify.sh 1 --full   # runs it as part of full verification'] : []),
      ]
    : [
        `Edit .har/stages/${id}.sh — replace the TODO block with the real check`,
        './.har/launch.sh 1',
        `./.har/stages/${id}.sh 1`,
        ...(verification ? ['./.har/verify.sh 1 --full   # runs it as part of full verification'] : []),
      ];

  return {
    stageId: id,
    kind,
    mode: options.command ? 'command' : 'script',
    filesWritten,
    verification,
    nextSteps,
  };
}
