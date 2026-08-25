import * as fs from 'fs';
import * as path from 'path';
import { HarnessStage, HarnessStageRegistry } from './schema';
import { readHarnessEnv, readValidatedHarnessEnv } from './env';
import { getHarnessDir } from './manifest';
import { readStageRegistry, writeStageRegistry } from './stages';

/** Stage kinds that may appear in verificationStages. */
export const RUNNABLE_VERIFICATION_KINDS = new Set(['test', 'custom']);

export interface VerificationPlan {
  /** Stages to execute, in verificationStages order. */
  steps: HarnessStage[];
  /** Ids listed in verificationStages that resolve to no runnable stage. */
  phantomIds: string[];
}

/**
 * Resolve the verification plan from the registry. verificationStages is the
 * single namespace and its order is execution order: every id must map to a
 * registered stage of a runnable kind. Quick mode keeps tier 'quick' stages
 * only; full mode runs the whole list.
 */
export function resolveVerificationPlan(
  registry: HarnessStageRegistry,
  options: { full?: boolean } = {},
): VerificationPlan {
  const ids = registry.verificationStages ?? [];
  const steps: HarnessStage[] = [];
  const phantomIds: string[] = [];

  for (const id of ids) {
    const stage = registry.stages.find((s) => s.id === id);
    if (!stage || !RUNNABLE_VERIFICATION_KINDS.has(stage.kind)) {
      phantomIds.push(id);
      continue;
    }
    if (!options.full && stage.tier !== 'quick') continue;
    steps.push(stage);
  }

  return { steps, phantomIds };
}

/**
 * Ids in verificationStages that do not resolve to a registered runnable
 * stage. Consumed by validateHarness (warning) and `har env doctor` (#232,
 * error).
 */
export function findPhantomVerificationStageIds(registry: HarnessStageRegistry): string[] {
  return resolveVerificationPlan(registry, { full: true }).phantomIds;
}

interface EcosystemStageDefaults {
  order: string[];
  stages: HarnessStage[];
}

function nodeSmokeCommand(repoPath: string): { id: string; command: string; description: string } {
  const pkgPath = path.join(repoPath, 'package.json');
  let scripts: Record<string, unknown> = {};
  try {
    scripts = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).scripts ?? {};
  } catch {
    scripts = {};
  }
  if (scripts.typecheck) {
    return {
      id: 'typecheck',
      command: '${NPM_BIN:-npm} run typecheck',
      description: 'Type check (ecosystem quick smoke)',
    };
  }
  if (scripts.build) {
    return {
      id: 'typecheck',
      // NODE_ENV=production: verify exports the slot env file, whose
      // NODE_ENV=development is meant for the dev server — framework builds
      // (e.g. next build) break under it. Same pinning as the pre-1.0
      // vendored node-build step.
      command: 'NODE_ENV=production ${NPM_BIN:-npm} run build',
      description: 'Build smoke (no typecheck script; ecosystem quick smoke)',
    };
  }
  return {
    id: 'typecheck',
    command: '${NODE_BIN:-node} -e "require(\'./package.json\')"',
    description: 'Package-load smoke (no typecheck/build scripts)',
  };
}

function nodeScriptOrSkip(repoPath: string, script: string): string {
  const pkgPath = path.join(repoPath, 'package.json');
  try {
    const scripts = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).scripts ?? {};
    if (scripts[script]) {
      return script === 'test' ? '${NPM_BIN:-npm} test' : `\${NPM_BIN:-npm} run ${script}`;
    }
  } catch {
    /* fall through to skip */
  }
  return `echo 'No ${script} script configured; skipping.'`;
}

/**
 * Ecosystem-default verification stages, as data. These replace the
 * run_quick_smoke/run_full_checks case tables that lived in verify.sh.
 */
export function deriveEcosystemDefaultStages(
  ecosystem: string,
  repoPath: string,
): EcosystemStageDefaults {
  const quick = (stage: Partial<HarnessStage> & { id: string }): HarnessStage =>
    ({ kind: 'test', tier: 'quick', requiresAgentId: true, artifacts: [], ...stage }) as HarnessStage;
  const full = (stage: Partial<HarnessStage> & { id: string }): HarnessStage =>
    ({ kind: 'test', tier: 'full', requiresAgentId: true, artifacts: [], ...stage }) as HarnessStage;

  const readiness = full({
    id: 'readiness',
    script: 'stages/readiness.sh',
    description: 'Project readiness smoke (HARNESS_READINESS_CMD)',
  });

  switch (ecosystem) {
    case 'node': {
      const smoke = nodeSmokeCommand(repoPath);
      return {
        order: ['typecheck', 'unit-tests', 'lint', 'readiness'],
        stages: [
          quick({ id: smoke.id, command: smoke.command, description: smoke.description }),
          full({ id: 'unit-tests', command: nodeScriptOrSkip(repoPath, 'test'), description: 'Unit tests' }),
          full({ id: 'lint', command: nodeScriptOrSkip(repoPath, 'lint'), description: 'Lint' }),
          readiness,
        ],
      };
    }
    case 'python':
      return {
        order: ['typecheck', 'unit-tests', 'readiness'],
        stages: [
          quick({
            id: 'typecheck',
            command: '${PYTHON_BIN:-python3} -m compileall -q .',
            description: 'Python compile smoke',
          }),
          full({
            id: 'unit-tests',
            command:
              'if ${PYTHON_BIN:-python3} -c "import pytest" >/dev/null 2>&1; then ${PYTHON_BIN:-python3} -m pytest -q; else echo "pytest not installed; adapt stages.json for this Python repo."; fi',
            description: 'Unit tests (pytest)',
          }),
          readiness,
        ],
      };
    case 'go':
      return {
        order: ['typecheck', 'unit-tests', 'readiness'],
        stages: [
          quick({ id: 'typecheck', command: '${GO_BIN:-go} build ./...', description: 'Go build smoke' }),
          full({ id: 'unit-tests', command: '${GO_BIN:-go} test ./...', description: 'Unit tests' }),
          readiness,
        ],
      };
    case 'rust':
      return {
        order: ['typecheck', 'unit-tests', 'readiness'],
        stages: [
          quick({ id: 'typecheck', command: '${CARGO_BIN:-cargo} check', description: 'Cargo check smoke' }),
          full({ id: 'unit-tests', command: '${CARGO_BIN:-cargo} test', description: 'Unit tests' }),
          readiness,
        ],
      };
    case 'java':
      return {
        order: ['typecheck', 'unit-tests', 'readiness'],
        stages: [
          quick({
            id: 'typecheck',
            command:
              'if [ -x ./mvnw ]; then ./mvnw -q -DskipTests compile; elif command -v mvn >/dev/null 2>&1; then mvn -q -DskipTests compile; elif [ -x ./gradlew ]; then ./gradlew classes; elif command -v gradle >/dev/null 2>&1; then gradle classes; else echo "No Maven/Gradle command found; adapt stages.json for this Java repo."; fi',
            description: 'Java compile smoke',
          }),
          full({
            id: 'unit-tests',
            command:
              'if [ -x ./mvnw ]; then ./mvnw -q test; elif command -v mvn >/dev/null 2>&1; then mvn -q test; elif [ -x ./gradlew ]; then ./gradlew test; elif command -v gradle >/dev/null 2>&1; then gradle test; else echo "No Maven/Gradle command found; adapt stages.json for this Java repo."; fi',
            description: 'Unit tests',
          }),
          readiness,
        ],
      };
    case 'ruby':
      return {
        order: ['typecheck', 'unit-tests', 'readiness'],
        stages: [
          quick({
            id: 'typecheck',
            command: '${RUBY_BIN:-ruby} -e "puts RUBY_VERSION"',
            description: 'Ruby smoke',
          }),
          full({
            id: 'unit-tests',
            command:
              'if command -v "${BUNDLE_BIN:-bundle}" >/dev/null 2>&1 && [ -f Gemfile ]; then "${BUNDLE_BIN:-bundle}" exec rake test 2>/dev/null || "${BUNDLE_BIN:-bundle}" exec rspec; else echo "No Ruby test command detected; adapt stages.json for this Ruby repo."; fi',
            description: 'Unit tests',
          }),
          readiness,
        ],
      };
    default:
      return {
        order: ['typecheck', 'readiness'],
        stages: [
          quick({
            id: 'typecheck',
            command: `echo 'No stock smoke for HARNESS_ECOSYSTEM=${ecosystem}; adapt .har/stages.json for this repo.'`,
            description: 'Placeholder smoke — adapt stages.json',
          }),
          readiness,
        ],
      };
  }
}

/**
 * Register the ecosystem-default verification stages (derived from
 * HARNESS_ECOSYSTEM) in stages.json. Fills in missing stages and
 * verificationStages entries only — never overwrites stages a user or
 * adaptation already customized. Called at init and maintain.
 */
export function ensureEcosystemVerificationStages(repoPath: string): boolean {
  // Only 1.0-contract harnesses get synced: a pre-1.0 harness.env (functions,
  // port triplets) means verify.sh still owns inline steps, and registering
  // defaults there would double-run or break them. Migration is #241.
  const validation = readValidatedHarnessEnv(repoPath);
  if (!validation || !validation.ok) return false;

  const env = readHarnessEnv(repoPath);
  const ecosystem = env.HARNESS_ECOSYSTEM || 'none';
  const defaults = deriveEcosystemDefaultStages(ecosystem, repoPath);
  const harnessDir = getHarnessDir(repoPath);

  const registry = readStageRegistry(repoPath);
  const stages = [...registry.stages];
  let changed = false;
  const skipped = new Set<string>();

  for (const stage of defaults.stages) {
    if (stages.some((s) => s.id === stage.id)) continue;
    if (stage.script && !fs.existsSync(path.join(harnessDir, stage.script))) {
      skipped.add(stage.id);
      continue;
    }
    stages.push(stage);
    changed = true;
  }

  const verificationStages = [...(registry.verificationStages ?? [])];
  // Insert missing defaults ahead of existing extras (plugins append at the
  // end), preserving the relative order users already chose.
  let insertAt = 0;
  for (const id of defaults.order) {
    if (skipped.has(id) && !stages.some((s) => s.id === id)) continue;
    const existing = verificationStages.indexOf(id);
    if (existing >= 0) {
      insertAt = existing + 1;
      continue;
    }
    verificationStages.splice(insertAt, 0, id);
    insertAt += 1;
    changed = true;
  }

  if (!changed) return false;
  writeStageRegistry(repoPath, { ...registry, stages, verificationStages });
  return true;
}
