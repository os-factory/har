import * as fs from 'fs';
import * as path from 'path';
import {
  HAR_AGENT_SLOT_MIN,
  HarnessStage,
  HarnessStageKind,
  HarnessStageRegistry,
  HarnessStageRegistrySchema,
  HarnessStageSchema,
} from './schema';
import { parseHarnessEnvInt, readHarnessEnv } from './env';
import { getHarnessDir } from './manifest';

export const STAGE_REGISTRY_FILE = 'stages.json';

const AGENT_REQUIRED_KINDS = new Set<HarnessStageKind>([
  'launch',
  'verify',
  'test',
  'inspect',
  'reset',
  'teardown',
  'custom',
]);

export interface StageLookup {
  id?: string;
  kind?: HarnessStageKind;
}

export function getStageRegistryPath(repoPath: string): string {
  return path.join(getHarnessDir(repoPath), STAGE_REGISTRY_FILE);
}

export function synthesizeStageRegistry(repoPath: string): HarnessStageRegistry {
  const harnessDir = getHarnessDir(repoPath);
  const stages: HarnessStage[] = [];

  addStageIfRunnable(stages, harnessDir, {
    id: 'setup-infra',
    kind: 'setup',
    description: 'Start shared harness infrastructure.',
    command: './.har/setup-infra.sh',
    requiresAgentId: false,
  });
  addStageIfRunnable(stages, harnessDir, {
    id: 'launch',
    kind: 'launch',
    description: 'Launch an isolated agent environment slot.',
    command: './.har/launch.sh {agentId}',
    requiresAgentId: true,
  });
  addStageIfRunnable(stages, harnessDir, {
    id: 'verify',
    kind: 'verify',
    description: 'Run the project verification pipeline.',
    command: './.har/verify.sh {agentId}',
    requiresAgentId: true,
    acceptsArgs: ['--full'],
  });
  addStageIfRunnable(stages, harnessDir, {
    id: 'status',
    kind: 'inspect',
    description: 'Inspect a running agent environment slot.',
    command: './.har/agent-cli.sh {agentId} status',
    requiresAgentId: true,
  });
  addStageIfRunnable(stages, harnessDir, {
    id: 'logs',
    kind: 'inspect',
    description: 'Read recent logs for an agent slot.',
    command: './.har/agent-cli.sh {agentId} logs',
    requiresAgentId: true,
  });
  addStageIfRunnable(stages, harnessDir, {
    id: 'teardown',
    kind: 'teardown',
    description: 'Tear down an isolated agent environment slot.',
    command: './.har/teardown.sh {agentId}',
    requiresAgentId: true,
  });

  const harnessEnv = readHarnessEnv(repoPath);
  const agentSlots = readAgentSlotsFromHarnessEnv(harnessEnv);
  if (!agentSlots) {
    throw new Error(
      'Configure agent slot limits in .har/stages.json (agentSlots) or .har/harness.env (HARNESS_AGENT_SLOT_MIN/MAX)',
    );
  }

  return {
    version: '1',
    artifactsDir: 'artifacts',
    logsDir: 'logs',
    agentSlots,
    verificationStages: ['typecheck', 'unit-tests', 'api-health'],
    stages,
  };
}

function readAgentSlotsFromHarnessEnv(
  harnessEnv: Record<string, string>,
): { min: number; max: number } | null {
  const max = parseHarnessEnvInt(harnessEnv, 'HARNESS_AGENT_SLOT_MAX');
  if (max === undefined) return null;
  const min = parseHarnessEnvInt(harnessEnv, 'HARNESS_AGENT_SLOT_MIN') ?? HAR_AGENT_SLOT_MIN;
  if (max < min) {
    throw new Error('HARNESS_AGENT_SLOT_MAX must be >= HARNESS_AGENT_SLOT_MIN in harness.env');
  }
  return { min, max };
}

function stageScriptExists(harnessDir: string, stage: HarnessStage): boolean {
  if (stage.script) {
    return fs.existsSync(path.join(harnessDir, stage.script));
  }
  if (stage.command) {
    const scriptName = stage.command
      .split(/\s+/)[0]
      .replace(/^\.\/\.har\//, '')
      .replace(/^\.\//, '');
    return fs.existsSync(path.join(harnessDir, scriptName));
  }
  return fs.existsSync(path.join(harnessDir, 'stages', `${stage.id}.sh`));
}

function addStageIfRunnable(
  stages: HarnessStage[],
  harnessDir: string,
  stage: Record<string, unknown>,
): void {
  const parsed = HarnessStageSchema.parse(stage);
  if (stageScriptExists(harnessDir, parsed)) {
    stages.push(parsed);
  }
}

export function readStageRegistry(repoPath: string): HarnessStageRegistry {
  const registryPath = getStageRegistryPath(repoPath);
  if (!fs.existsSync(registryPath)) {
    return synthesizeStageRegistry(repoPath);
  }

  const raw = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const parsed = HarnessStageRegistrySchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid .har/${STAGE_REGISTRY_FILE}: ${parsed.error.message}`);
  }
  return parsed.data;
}

export function writeStageRegistry(repoPath: string, registry: HarnessStageRegistry): void {
  const registryPath = getStageRegistryPath(repoPath);
  const parsed = HarnessStageRegistrySchema.safeParse(registry);
  if (!parsed.success) {
    throw new Error(`Invalid stage registry: ${parsed.error.message}`);
  }
  fs.writeFileSync(registryPath, JSON.stringify(parsed.data, null, 2) + '\n');
}

export function listStages(repoPath: string): HarnessStage[] {
  return readStageRegistry(repoPath).stages;
}

export function getAgentSlotRange(repoPath: string): { min: number; max: number } {
  const registry = readStageRegistry(repoPath);
  if (registry.agentSlots) {
    return registry.agentSlots;
  }

  const fromEnv = readAgentSlotsFromHarnessEnv(readHarnessEnv(repoPath));
  if (fromEnv) {
    return fromEnv;
  }

  throw new Error(
    'Configure agent slot limits in .har/stages.json (agentSlots) or .har/harness.env (HARNESS_AGENT_SLOT_MIN/MAX)',
  );
}

export function getAgentSlotIds(repoPath: string): number[] {
  const { min, max } = getAgentSlotRange(repoPath);
  const ids: number[] = [];
  for (let id = min; id <= max; id++) ids.push(id);
  return ids;
}

export function stageRequiresAgentId(stage: HarnessStage): boolean {
  if (typeof stage.requiresAgentId === 'boolean') return stage.requiresAgentId;
  return AGENT_REQUIRED_KINDS.has(stage.kind);
}

export function resolveStage(
  repoPath: string,
  options: StageLookup,
): HarnessStage | null {
  if (!options.id && !options.kind) return null;

  const stages = listStages(repoPath);
  if (options.id) {
    return stages.find((stage) => stage.id === options.id) ?? null;
  }

  const matches = stages.filter((stage) => stage.kind === options.kind);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(
      `Multiple stages with kind "${options.kind}". Specify stage id. Available: ${matches.map((s) => s.id).join(', ')}`,
    );
  }
  return null;
}

export function getVerificationStageIds(repoPath: string): string[] {
  const registry = readStageRegistry(repoPath);
  if (Array.isArray(registry.verificationStages) && registry.verificationStages.length > 0) {
    return registry.verificationStages;
  }
  return registry.stages.filter((stage) => stage.group === 'verification').map((stage) => stage.id);
}

export function getArtifactsDir(repoPath: string): string {
  return readStageRegistry(repoPath).artifactsDir ?? 'artifacts';
}

export function getLogsDir(repoPath: string): string {
  return readStageRegistry(repoPath).logsDir ?? 'logs';
}
