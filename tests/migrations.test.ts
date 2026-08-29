import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { maintainHarness } from '../src/core/harness';
import { runDoctor } from '../src/harness/doctor';
import { scaffoldHarnessBoilerplate } from '../src/harness/generator';
import { readManifest, writeManifest, HARNESS_RUNTIME_VERSION } from '../src/harness/manifest';
import { MIGRATE_PROMPT_FILE } from '../src/harness/migrate-prompt';
import {
  isPre10Harness,
  migrateHarnessEnvContent,
  pendingMigrations,
  PRE_1_0_MIGRATION,
} from '../src/harness/migrations';

/**
 * #241 acceptance: a pre-1.0 harness is detected by maintain, the mechanical
 * steps run as code (`--migrate`) with full backups, the residue only an
 * agent can lift lands in MIGRATE-PROMPT.md, and nothing changes until the
 * user opts in (compat window).
 */
describe('versioned harness migrations (#241)', () => {
  let repo: string;

  const proj = () => path.join(repo, 'proj');
  const har = (...p: string[]) => path.join(proj(), '.har', ...p);

  const PRE10_ENV = [
    '# Shared harness configuration',
    'export HARNESS_PROJECT_NAME=proj',
    'export HARNESS_USE_WORKTREE=true',
    'export HARNESS_FE_BASE_PORT=3010',
    'export HARNESS_API_BASE_PORT=3010',
    'export HARNESS_PORT_STEP=10',
    'export HARNESS_HEALTH_CHECK_PATH=/api/health',
    'export HARNESS_INFRA_POSTGRES=true',
    'export HARNESS_TEMPLATE_SQLITE=.har/state/template/db.sqlite',
    'export HARNESS_DB_PORT_DEFAULT=15432',
    'export HARNESS_DB_PORT_SCAN_START=15432',
    'export HARNESS_DB_PORT_SCAN_END=15499',
    'export HARNESS_MINIO_PORT_DEFAULT=19000',
    'export HARNESS_MINIO_PORT_SCAN_START=19000',
    'export HARNESS_MINIO_PORT_SCAN_END=19099',
    'har_infra_enabled() {',
    '  case " ${HARNESS_INFRA_SERVICES:-} " in *" $1 "*) return 0;; esac',
    '  return 1',
    '}',
    'my_custom_seed() {',
    '  echo seeding',
    '}',
    '',
  ].join('\n');

  /** Devolve a fresh 1.0 scaffold into the pre-1.0 vendored shape. */
  function makePre10(): void {
    fs.writeFileSync(
      har('launch.sh'),
      '#!/usr/bin/env bash\n# vendored pre-1.0 runtime\nsource "$(dirname "$0")/harness.env"\nhar_infra_enabled db && echo db\necho custom-sqlite-clone\n',
    );
    fs.writeFileSync(har('verify.sh'), '#!/usr/bin/env bash\n# vendored verify pipeline\nrun_quick_smoke\n');
    fs.writeFileSync(har('agent-slot.sh'), '#!/usr/bin/env bash\necho slot machinery\n');
    // The default profile ships attach.sh, and pre-1.0 it sourced agent-slot.sh (#297).
    fs.writeFileSync(
      har('attach.sh'),
      '#!/usr/bin/env bash\nsource "$SCRIPT_DIR/harness.env"\nsource "$SCRIPT_DIR/agent-slot.sh"\nexec tmux attach -t "$(har_tmux_session "$1")"\n',
    );
    fs.writeFileSync(har('provision-toolchain.sh'), '#!/usr/bin/env bash\necho provision\n');
    fs.mkdirSync(har('lib'), { recursive: true });
    fs.writeFileSync(har('lib', 'infra.sh'), 'har_infra_enabled() { return 1; }\n');
    fs.writeFileSync(har('harness.env'), PRE10_ENV);
    const manifest = readManifest(proj())!;
    // Pre-1.0 manifests carry no runtimeVersion / template baseline; record
    // the vendored files as the last-finalize baseline (adaptation blessed).
    delete (manifest as Record<string, unknown>).runtimeVersion;
    delete (manifest as Record<string, unknown>).templateChecksums;
    writeManifest(proj(), manifest);
  }

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'har-migrate-'));
    scaffoldHarnessBoilerplate(proj(), { profile: 'default' });
    makePre10();
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('detects the pre-1.0 shape and reports a pending migration', () => {
    expect(isPre10Harness(proj())).toBe(true);
    const pending = pendingMigrations(proj());
    expect(pending.map((m) => m.id)).toEqual(['config-surface']);
    expect(pending[0].to).toBe(HARNESS_RUNTIME_VERSION);
  });

  it('a fresh 1.0 scaffold has no pending migration', () => {
    const clean = path.join(repo, 'clean');
    scaffoldHarnessBoilerplate(clean, { profile: 'default' });
    expect(isPre10Harness(clean)).toBe(false);
    expect(pendingMigrations(clean)).toEqual([]);
  });

  it('an ejected harness is never treated as pre-1.0', () => {
    const manifest = readManifest(proj())!;
    writeManifest(proj(), { ...manifest, ejected: true, ejectedVersion: '1.0.0' });
    expect(isPre10Harness(proj())).toBe(false);
    expect(pendingMigrations(proj())).toEqual([]);
  });

  it('plan classifies scripts, machinery, and env residue', () => {
    const plan = PRE_1_0_MIGRATION.plan(proj());
    expect(plan.deleteLifecycleScripts).toContain('launch.sh');
    expect(plan.deleteLifecycleScripts).toContain('verify.sh');
    expect(plan.deleteMachinery).toEqual(
      expect.arrayContaining(['agent-slot.sh', 'provision-toolchain.sh', 'lib/infra.sh']),
    );
    const sources = plan.residue.map((r) => r.source);
    expect(sources).toContain('launch.sh');
    expect(sources).toContain('verify.sh');
    // Custom function and custom key are residue; the stock helper is not.
    expect(sources).toContain('harness.env: my_custom_seed()');
    expect(sources).toContain('harness.env: HARNESS_TEMPLATE_SQLITE');
    expect(sources).not.toContain('harness.env: har_infra_enabled()');
    const verifyResidue = plan.residue.find((r) => r.source === 'verify.sh');
    expect(verifyResidue?.target).toBe('stage');
    const launchResidue = plan.residue.find((r) => r.source === 'launch.sh');
    expect(launchResidue?.target).toBe('hook');
  });

  // #297: attach.sh was absent from the shim surface, so migration left the
  // vendored copy in place *and* deleted the agent-slot.sh it sourced.
  it('migrates a vendored attach.sh instead of orphaning it', async () => {
    expect(PRE_1_0_MIGRATION.plan(proj()).deleteLifecycleScripts).toContain('attach.sh');

    await maintainHarness({ repoPath: proj(), migrate: true });

    expect(fs.existsSync(har('attach.sh'))).toBe(false);
    expect(fs.existsSync(har('agent-slot.sh'))).toBe(false);
    // The pre-1.0 copy is recoverable until finalize.
    expect(fs.existsSync(har('migrate', 'backup', 'attach.sh'))).toBe(true);
  });

  // A harness whose only vendored leftover is attach.sh must still be offered
  // the migration — isPre10Harness used to ask about six scripts, not seven.
  it('detects a harness whose only vendored script is attach.sh', () => {
    const clean = path.join(repo, 'attach-only');
    scaffoldHarnessBoilerplate(clean, { profile: 'default' });
    expect(isPre10Harness(clean)).toBe(false);
    fs.writeFileSync(
      path.join(clean, '.har', 'attach.sh'),
      '#!/usr/bin/env bash\nsource "$SCRIPT_DIR/agent-slot.sh"\n',
    );
    expect(isPre10Harness(clean)).toBe(true);
  });

  // Machinery must never be deleted out from under a script that survives the
  // migration, wherever that script lives in .har/ (#297).
  it('retains machinery still sourced by a surviving harness-root script', () => {
    fs.writeFileSync(
      har('my-helper.sh'),
      '#!/usr/bin/env bash\nsource "$SCRIPT_DIR/agent-slot.sh"\necho custom\n',
    );
    const plan = PRE_1_0_MIGRATION.plan(proj());
    expect(plan.retainMachinery).toContain('agent-slot.sh');
    expect(plan.deleteMachinery).not.toContain('agent-slot.sh');
    const residue = plan.residue.find((r) => r.source === 'agent-slot.sh');
    expect(residue?.reason).toContain('my-helper.sh');
  });

  // #301: CLAUDE.agent.md is no longer generated. Users adapt theirs with real
  // project knowledge, so migration backs it up and asks the agent to lift it —
  // never deletes it silently.
  it('reports a retired CLAUDE.agent.md as residue and backs it up', async () => {
    fs.writeFileSync(har('CLAUDE.agent.md'), '# Agent 1\n\nOur credentials: seed@example.com\n');

    const plan = PRE_1_0_MIGRATION.plan(proj());
    expect(plan.retireDocs).toContain('CLAUDE.agent.md');
    const residue = plan.residue.find((r) => r.source === 'CLAUDE.agent.md');
    expect(residue?.reason).toContain('.har/README.md');

    await maintainHarness({ repoPath: proj(), migrate: true });

    expect(fs.readFileSync(har('migrate', 'backup', 'CLAUDE.agent.md'), 'utf8')).toContain(
      'seed@example.com',
    );
    // Left on disk for the lift — the prompt tells the agent to delete it after.
    expect(fs.existsSync(har('CLAUDE.agent.md'))).toBe(true);
    expect(fs.readFileSync(har(MIGRATE_PROMPT_FILE), 'utf8')).toContain('CLAUDE.agent.md');
  });

  it('a harness without CLAUDE.agent.md reports no retired docs', () => {
    expect(PRE_1_0_MIGRATION.plan(proj()).retireDocs).toEqual([]);
  });

  // The contract check that would have caught the broken dogfood harness.
  it('doctor fails when a surviving script loads retired machinery', async () => {
    await maintainHarness({ repoPath: proj(), migrate: true });
    expect(runDoctor(proj()).ok).toBe(true);

    fs.mkdirSync(har('stages'), { recursive: true });
    fs.writeFileSync(
      har('stages', 'legacy.sh'),
      '#!/usr/bin/env bash\nsource "$HAR_HARNESS_DIR/agent-slot.sh"\n',
    );
    const report = runDoctor(proj());
    expect(report.ok).toBe(false);
    const finding = report.findings.find((f) => f.check === 'retired-machinery');
    expect(finding?.severity).toBe('error');
    expect(finding?.file).toBe('stages/legacy.sh');
    expect(finding?.message).toContain('agent-slot.sh');
  });

  it('drops verificationStages ids the registry cannot resolve and surfaces them as residue', async () => {
    const stagesPath = har('stages.json');
    const registry = JSON.parse(fs.readFileSync(stagesPath, 'utf8'));
    registry.verificationStages = [...(registry.verificationStages ?? []), 'node-build'];
    fs.writeFileSync(stagesPath, JSON.stringify(registry, null, 2) + '\n');

    const plan = PRE_1_0_MIGRATION.plan(proj());
    expect(plan.phantomVerificationIds).toContain('node-build');
    expect(plan.residue.map((r) => r.source)).toContain('stages.json: verificationStages "node-build"');

    await maintainHarness({ repoPath: proj(), migrate: true });
    const after = JSON.parse(fs.readFileSync(stagesPath, 'utf8'));
    expect(after.verificationStages).not.toContain('node-build');
    // The pre-drop registry is preserved for the lift.
    expect(fs.existsSync(har('migrate', 'backup', 'stages.json'))).toBe(true);
  });

  it('retains machinery still sourced by surviving stage scripts and flags the rewrite', async () => {
    fs.mkdirSync(har('stages'), { recursive: true });
    fs.writeFileSync(
      har('stages', 'custom-e2e.sh'),
      '#!/usr/bin/env bash\nsource "$(dirname "$0")/../agent-slot.sh"\nvalidate_agent_id "$1"\n',
    );

    const plan = PRE_1_0_MIGRATION.plan(proj());
    expect(plan.retainMachinery).toEqual(['agent-slot.sh']);
    expect(plan.deleteMachinery).not.toContain('agent-slot.sh');
    const item = plan.residue.find((r) => r.source === 'agent-slot.sh');
    expect(item?.reason).toContain('stages/custom-e2e.sh');

    await maintainHarness({ repoPath: proj(), migrate: true });
    // Referenced machinery survives; unreferenced machinery is gone.
    expect(fs.existsSync(har('agent-slot.sh'))).toBe(true);
    expect(fs.existsSync(har('provision-toolchain.sh'))).toBe(false);
  });

  it('migrateHarnessEnvContent purifies config and converts legacy shapes', () => {
    const result = migrateHarnessEnvContent(PRE10_ENV);
    expect(result.removedFunctions).toEqual(['har_infra_enabled', 'my_custom_seed']);
    expect(result.customFunctions).toEqual(['my_custom_seed']);
    expect(result.convertedFlags).toEqual(['HARNESS_INFRA_POSTGRES']);
    expect(result.services).toEqual(['db']);
    // db lane converted (service enabled); minio triplets dropped (not enabled).
    expect(result.portLanes).toBe('db=15432:15432-15499');
    expect(result.commentedKeys).toEqual(['HARNESS_TEMPLATE_SQLITE']);
    expect(result.content).toContain('export HARNESS_INFRA_SERVICES="db"');
    expect(result.content).toContain('export HARNESS_INFRA_PORT_LANES="db=15432:15432-15499"');
    expect(result.content).toContain('# [migrated 0.x — custom key');
    expect(result.content).not.toMatch(/^\s*har_infra_enabled\(\)/m);
    expect(result.content).not.toMatch(/^export HARNESS_DB_PORT_DEFAULT=/m);
    expect(result.content).not.toMatch(/^export HARNESS_INFRA_POSTGRES=/m);
  });

  it('migrateHarnessEnvContent normalizes legacy `true` no-op command sentinels to ""', () => {
    const result = migrateHarnessEnvContent(
      'export HARNESS_DB_MIGRATE_CMD="true"\nexport HARNESS_DB_SEED_CMD=true\nexport HARNESS_READINESS_CMD="curl -f localhost"\n',
    );
    expect(result.normalizedNoopCmds).toEqual(['HARNESS_DB_MIGRATE_CMD', 'HARNESS_DB_SEED_CMD']);
    expect(result.content).toContain('export HARNESS_DB_MIGRATE_CMD=""');
    expect(result.content).toContain('export HARNESS_DB_SEED_CMD=""');
    // Real commands pass through untouched — only the bare `true` sentinel is normalized.
    expect(result.content).toContain('export HARNESS_READINESS_CMD="curl -f localhost"');
  });

  it('migrateHarnessEnvContent drops stock helper constants (HAR_NODE_PACKAGE_MANAGERS)', () => {
    const result = migrateHarnessEnvContent(
      'HAR_NODE_PACKAGE_MANAGERS="npm bun pnpm yarn"\nexport HARNESS_PROJECT_NAME=proj\n',
    );
    expect(result.content).not.toContain('HAR_NODE_PACKAGE_MANAGERS');
    expect(result.content).toContain('export HARNESS_PROJECT_NAME=proj');
  });

  it('plain maintain detects, writes plan + MIGRATE prompt, changes nothing (compat window)', async () => {
    const vendoredLaunch = fs.readFileSync(har('launch.sh'), 'utf8');
    const result = await maintainHarness({ repoPath: proj() });

    expect(result.migration).toBeDefined();
    expect(result.migration!.applied).toBe(false);
    expect(fs.existsSync(har(MIGRATE_PROMPT_FILE))).toBe(true);
    expect(fs.existsSync(har('migrate', 'plan.json'))).toBe(true);
    // Nothing touched: the vendored runtime keeps working until --migrate.
    expect(fs.readFileSync(har('launch.sh'), 'utf8')).toBe(vendoredLaunch);
    expect(fs.existsSync(har('agent-slot.sh'))).toBe(true);
    expect(result.migration!.prompt).toContain('har env maintain --migrate');
    expect(result.migration!.prompt).toContain('HARNESS_TEMPLATE_SQLITE');
  });

  it('maintain --migrate applies mechanical steps with backups and stamps the manifest', async () => {
    const result = await maintainHarness({ repoPath: proj(), migrate: true });
    expect(result.migration?.applied).toBe(true);

    // Lifecycle wrappers deleted, machinery gone, env pure.
    expect(fs.existsSync(har('launch.sh'))).toBe(false);
    expect(fs.existsSync(har('verify.sh'))).toBe(false);
    expect(fs.existsSync(har('agent-slot.sh'))).toBe(false);
    expect(fs.existsSync(har('provision-toolchain.sh'))).toBe(false);
    // lib/infra.sh is machinery; lib/ itself may stay (1.0 still ships verify-runner.mjs).
    expect(fs.existsSync(har('lib', 'infra.sh'))).toBe(false);
    const env = fs.readFileSync(har('harness.env'), 'utf8');
    expect(env).not.toMatch(/\(\)\s*\{/);
    expect(env).toContain('HARNESS_INFRA_PORT_LANES');

    // Every replaced/deleted file is backed up.
    for (const file of ['launch.sh', 'verify.sh', 'agent-slot.sh', 'harness.env', 'lib/infra.sh']) {
      expect(fs.existsSync(har('migrate', 'backup', file))).toBe(true);
    }
    expect(fs.readFileSync(har('migrate', 'backup', 'launch.sh'), 'utf8')).toContain(
      'custom-sqlite-clone',
    );

    // Manifest stamped and re-baselined; shape now 1.0, nothing pending.
    const manifest = readManifest(proj())!;
    expect(manifest.runtimeVersion).toBe(HARNESS_RUNTIME_VERSION);
    expect(manifest.migratedFrom).toBe('pre-1.0');
    expect(manifest.templateChecksums).toBeDefined();
    expect(isPre10Harness(proj())).toBe(false);
    expect(pendingMigrations(proj())).toEqual([]);

    // Doctor: 1.0 contract, no errors — the harness is coherent post-migration.
    const doctor = runDoctor(proj());
    expect(doctor.contract).toBe('1.0');
    expect(doctor.findings.filter((f) => f.severity === 'error')).toEqual([]);

    // Prompt regenerated in applied mode with the residue table.
    const prompt = fs.readFileSync(har(MIGRATE_PROMPT_FILE), 'utf8');
    expect(prompt).toContain('Mechanical migration: DONE');
    expect(prompt).toContain('my_custom_seed');
  });

  it('post-migration drift is clean and finalize clears the migration artifacts', async () => {
    await maintainHarness({ repoPath: proj(), migrate: true });
    const after = await maintainHarness({ repoPath: proj() });
    expect(after.migration).toBeUndefined();
    expect(after.drift.upstreamUpdated).toEqual([]);
    expect(after.drift.conflict).toEqual([]);

    const final = await maintainHarness({
      repoPath: proj(),
      finalize: true,
      summary: 'migrated to 1.0',
    });
    expect(final.validation.pass).toBe(true);
    expect(fs.existsSync(har('migrate'))).toBe(false);
    expect(fs.existsSync(har(MIGRATE_PROMPT_FILE))).toBe(false);
  });

  it('finalize on a still-pre-1.0 harness keeps the migration artifacts (backups are the only copy)', async () => {
    await maintainHarness({ repoPath: proj() }); // plan + prompt only
    await maintainHarness({ repoPath: proj(), finalize: true, summary: 'pre-1.0 finalize' }).catch(
      () => undefined, // validation may fail on the vendored shape — irrelevant here
    );
    expect(fs.existsSync(har(MIGRATE_PROMPT_FILE))).toBe(true);
  });
});
