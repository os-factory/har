import * as fs from 'fs';
import * as path from 'path';
import {
  HAR_AGENT_SLOT_MIN,
  HarnessAgentSlotsSchema,
  HarnessStage,
  HarnessStageKind,
  HarnessStageOverlay,
  HarnessStageOverlaySchema,
  HarnessStageRegistry,
  HarnessStageRegistrySchema,
  HarnessStageSchema,
} from './schema';
import { parseHarnessEnvInt, readHarnessEnv } from './env';
import { getHarnessDir } from './manifest';
import { ensureHarLocalIgnored, HAR_LOCAL_DIR, personalHarRoot } from './line-scope';

export { HAR_AGENT_SLOT_MIN };
export const STAGE_REGISTRY_FILE = 'stages.json';

/** `.har/`-relative path of the gitignored personal stage overlay. */
export const STAGE_OVERLAY_FILE = `${HAR_LOCAL_DIR}/${STAGE_REGISTRY_FILE}`;

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

/**
 * The stage registry every reader sees: the committed `.har/stages.json` plus
 * the stages of the gitignored overlay `.har/local/stages.json` (personal
 * factory lines). `verificationStages` and every other setting come from the
 * committed file only. A stage id in both files is an error, never an override.
 *
 * Writers must NOT read through this — use {@link readCommittedStageRegistry}
 * so a committed write can never pull personal stages into the shared file.
 */
export function readStageRegistry(repoPath: string): HarnessStageRegistry {
  const committed = readCommittedStageRegistry(repoPath);
  const overlay = readStageOverlay(repoPath);
  if (!overlay || overlay.stages.length === 0) return committed;

  const clashes = findStageOverlayClashes(committed, overlay);
  if (clashes.length > 0) {
    throw new Error(stageOverlayClashMessage(clashes));
  }
  return { ...committed, stages: [...committed.stages, ...overlay.stages] };
}

/** Stage ids registered in both the committed registry and the overlay. */
export function findStageOverlayClashes(
  committed: HarnessStageRegistry,
  overlay: HarnessStageOverlay,
): string[] {
  const committedIds = new Set(committed.stages.map((s) => s.id));
  return [...new Set(overlay.stages.map((s) => s.id).filter((id) => committedIds.has(id)))];
}

export function stageOverlayClashMessage(ids: string[]): string {
  return (
    `Stage id(s) ${ids.map((id) => `"${id}"`).join(', ')} are registered in both .har/${STAGE_REGISTRY_FILE} ` +
    `and the personal overlay .har/${STAGE_OVERLAY_FILE}. Remove one of them — an overlay stage never overrides a committed one.`
  );
}

/**
 * The personal overlay is gitignored, so a worktree slot has none of its own:
 * it reads (and writes) the main checkout's, next to the personal lines.
 */
export function getStageOverlayPath(repoPath: string): string {
  return path.join(getHarnessDir(personalHarRoot(repoPath)), STAGE_OVERLAY_FILE);
}

/** The personal stage overlay, or null when there is none. Throws when it is invalid. */
export function readStageOverlay(repoPath: string): HarnessStageOverlay | null {
  const overlayPath = getStageOverlayPath(repoPath);
  if (!fs.existsSync(overlayPath)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(overlayPath, 'utf8'));
  } catch (err) {
    throw new Error(`Invalid .har/${STAGE_OVERLAY_FILE}: ${(err as Error).message}`);
  }
  const parsed = HarnessStageOverlaySchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Invalid .har/${STAGE_OVERLAY_FILE} (it may hold only "version" and "stages"): ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

/** Write the personal overlay (gitignored). Removes the file when no stages remain. */
export function writeStageOverlay(repoPath: string, overlay: HarnessStageOverlay): void {
  const overlayPath = getStageOverlayPath(repoPath);
  const parsed = HarnessStageOverlaySchema.safeParse(overlay);
  if (!parsed.success) {
    throw new Error(`Invalid stage overlay: ${parsed.error.message}`);
  }
  if (parsed.data.stages.length === 0) {
    if (fs.existsSync(overlayPath)) fs.unlinkSync(overlayPath);
    return;
  }
  ensureHarLocalIgnored(personalHarRoot(repoPath));
  fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
  fs.writeFileSync(overlayPath, JSON.stringify(parsed.data, null, 2) + '\n');
}

/** The committed `.har/stages.json` alone — what every registry writer must start from. */
export function readCommittedStageRegistry(repoPath: string): HarnessStageRegistry {
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

/**
 * Write the committed `.har/stages.json`. Refuses to write a stage that lives
 * in the personal overlay — that would publish someone's personal line to the
 * team. Start from {@link readCommittedStageRegistry}, never the merged read.
 */
export function writeStageRegistry(repoPath: string, registry: HarnessStageRegistry): void {
  const registryPath = getStageRegistryPath(repoPath);
  const parsed = HarnessStageRegistrySchema.safeParse(registry);
  if (!parsed.success) {
    throw new Error(`Invalid stage registry: ${parsed.error.message}`);
  }
  const overlayIds = new Set(readStageOverlayIdsLenient(repoPath));
  const leaked = parsed.data.stages.filter((s) => overlayIds.has(s.id)).map((s) => s.id);
  if (leaked.length > 0) {
    throw new Error(
      `Refusing to write .har/${STAGE_REGISTRY_FILE}: stage(s) ${leaked.join(', ')} belong to the personal overlay ` +
        `(.har/${STAGE_OVERLAY_FILE}). A committed stage cannot share an id with a personal one — ` +
        'rename it, or remove the personal line that registered it.',
    );
  }
  fs.writeFileSync(registryPath, JSON.stringify(parsed.data, null, 2) + '\n');
}

/** Overlay stage ids, or [] when the overlay is missing or unreadable (doctor reports that). */
function readStageOverlayIdsLenient(repoPath: string): string[] {
  try {
    return readStageOverlay(repoPath)?.stages.map((s) => s.id) ?? [];
  } catch {
    return [];
  }
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
  const registry = readCommittedStageRegistry(repoPath);
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
  // Committed registry only: overlay stages can never join the verify plan.
  const registry = readCommittedStageRegistry(repoPath);
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
