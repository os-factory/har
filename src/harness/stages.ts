import * as fs from 'fs';
import * as path from 'path';
import {
  HAR_AGENT_SLOT_MIN,
  HarnessAgentSlotsSchema,
  HarnessStage,
  HarnessStageKind,
  HarnessStageRegistry,
  HarnessStageRegistrySchema,
  HarnessStageSchema,
} from './schema';
import { parseHarnessEnvInt, readHarnessEnv } from './env';
import { getHarnessDir } from './manifest';

export { HAR_AGENT_SLOT_MIN };
export const STAGE_REGISTRY_FILE = 'stages.json';

/** Upper bound offered during `har onboard` for parallel agent slots. */
export const HAR_AGENT_SLOT_ONBOARD_MAX = 10;

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
  const stages: HarnessStage[] = [];

  addKindDispatchedStage(stages, {
    id: 'setup-infra',
    kind: 'setup',
    description: 'Start shared harness infrastructure.',
    requiresAgentId: false,
  });
  addKindDispatchedStage(stages, {
    id: 'launch',
    kind: 'launch',
    description: 'Launch an isolated agent environment slot.',
    requiresAgentId: true,
  });
  addKindDispatchedStage(stages, {
    id: 'verify',
    kind: 'verify',
    description: 'Run the project verification pipeline.',
    requiresAgentId: true,
    acceptsArgs: ['--full'],
  });
  addKindDispatchedStage(stages, {
    id: 'status',
    kind: 'inspect',
    description: 'Inspect a running agent environment slot.',
    requiresAgentId: true,
  });
  addKindDispatchedStage(stages, {
    id: 'logs',
    kind: 'inspect',
    description: 'Read recent logs for an agent slot.',
    requiresAgentId: true,
  });
  addKindDispatchedStage(stages, {
    id: 'teardown',
    kind: 'teardown',
    description: 'Tear down an isolated agent environment slot.',
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

function addKindDispatchedStage(stages: HarnessStage[], stage: Record<string, unknown>): void {
  stages.push(HarnessStageSchema.parse(stage));
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

/** When both stages.json and harness.env define limits, returns a mismatch or null. */
export function detectAgentSlotEnvMismatch(
  repoPath: string,
): { stages: { min: number; max: number }; env: { min: number; max: number } } | null {
  const registryPath = getStageRegistryPath(repoPath);
  if (!fs.existsSync(registryPath)) return null;

  let stagesSlots: { min: number; max: number } | null = null;
  try {
    const raw = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    if (
      raw.agentSlots &&
      Number.isInteger(raw.agentSlots.min) &&
      Number.isInteger(raw.agentSlots.max)
    ) {
      stagesSlots = { min: raw.agentSlots.min, max: raw.agentSlots.max };
    }
  } catch {
    return null;
  }
  if (!stagesSlots) return null;

  const env = readHarnessEnv(repoPath);
  const envMax = parseHarnessEnvInt(env, 'HARNESS_AGENT_SLOT_MAX');
  if (envMax === undefined) return null;
  const envMin = parseHarnessEnvInt(env, 'HARNESS_AGENT_SLOT_MIN') ?? HAR_AGENT_SLOT_MIN;
  if (envMin === stagesSlots.min && envMax === stagesSlots.max) return null;
  return { stages: stagesSlots, env: { min: envMin, max: envMax } };
}

/** Sync legacy HARNESS_AGENT_SLOT_* exports in harness.env from stages.json agentSlots. */
export function syncAgentSlotsToHarnessEnv(repoPath: string): boolean {
  const mismatch = detectAgentSlotEnvMismatch(repoPath);
  if (!mismatch) return false;

  const envPath = path.join(getHarnessDir(repoPath), 'harness.env');
  if (!fs.existsSync(envPath)) return false;

  let content = fs.readFileSync(envPath, 'utf8');
  const minLine = `export HARNESS_AGENT_SLOT_MIN=${mismatch.stages.min}`;
  const maxLine = `export HARNESS_AGENT_SLOT_MAX=${mismatch.stages.max}`;

  if (/^export HARNESS_AGENT_SLOT_MIN=/m.test(content)) {
    content = content.replace(/^export HARNESS_AGENT_SLOT_MIN=.*$/m, minLine);
  } else {
    content = `${content.replace(/\s*$/, '')}\n${minLine}\n`;
  }
  if (/^export HARNESS_AGENT_SLOT_MAX=/m.test(content)) {
    content = content.replace(/^export HARNESS_AGENT_SLOT_MAX=.*$/m, maxLine);
  } else {
    content = `${content.replace(/\s*$/, '')}\n${maxLine}\n`;
  }

  fs.writeFileSync(envPath, content);
  return true;
}

/** Set `agentSlots.max` in stages.json and sync legacy harness.env exports. */
export function applyAgentSlotMax(repoPath: string, max: number): void {
  const slots = HarnessAgentSlotsSchema.parse({ min: HAR_AGENT_SLOT_MIN, max });
  const registry = readStageRegistry(repoPath);
  writeStageRegistry(repoPath, {
    ...registry,
    agentSlots: slots,
  });
  syncAgentSlotsToHarnessEnv(repoPath);
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
