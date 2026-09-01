import * as fs from 'fs';
import * as path from 'path';
import {
  HARNESS_ENV_KNOWN_KEYS,
  LEGACY_PORT_TRIPLET_PATTERN,
} from './schema';
import {
  computeFileChecksum,
  computeHarnessChecksums,
  getHarnessDir,
  HARNESS_RUNTIME_VERSION,
  readManifest,
  writeManifest,
} from './manifest';
import type { HarnessProfile } from './profiles';
import { composeProfileTemplateMap, readComposedTemplateContent } from './profiles';
import { MANAGED_SHIM_FILES, substituteTemplateTokens } from './template-tokens';
import { stripLifecycleShimCommands } from './lifecycle-shims';
import { computeTemplateChecksums } from './drift';
import { readStageRegistry, writeStageRegistry } from './stages';
import { findPhantomVerificationStageIds } from './verification';

/**
 * Versioned harness migrations (#241) — pre-1.0 → 1.0.
 *
 * The manifest's `runtimeVersion` records the shape of the installed `.har/`
 * surface; this registry holds the migrations keyed on the version they bring
 * a harness up to. Mechanical steps run as code (`har env maintain --migrate`);
 * everything that needs judgment — lifting customizations out of vendored
 * scripts into config/stages/hooks/local plugins — lands in the generated
 * `.har/MIGRATE-PROMPT.md` for the user's coding agent.
 *
 * Flow: `har env maintain` on a pre-1.0 harness detects the old shape, writes
 * the MIGRATE prompt, and changes nothing (compat window — the vendored
 * scripts keep executing, loudly deprecated). The prompt's first step is
 * `har env maintain --migrate`, which applies the mechanical steps with every
 * touched file backed up under `.har/migrate/backup/`.
 */

export { HARNESS_RUNTIME_VERSION } from './manifest';

export const MIGRATE_DIR = 'migrate';
export const MIGRATE_BACKUP_DIR = path.join(MIGRATE_DIR, 'backup');
export const MIGRATE_PLAN_FILE = path.join(MIGRATE_DIR, 'plan.json');

/**
 * Pre-1.0 runtime machinery superseded wholesale by the package runtime
 * (#234). Deleted mechanically (after backup); an edit since the last
 * finalize is flagged as residue for the MIGRATE prompt.
 */
export const LEGACY_MACHINERY_FILES = [
  'agent-slot.sh',
  'provision-toolchain.sh',
  'simulator.sh',
  'lib/infra.sh',
  'lib/node-pm.sh',
] as const;

/**
 * Docs 1.0 no longer generates (#301). `CLAUDE.agent.md` duplicated the AGENTS.md
 * workflow behind a vendor-specific name and was never rendered per slot (its
 * `${AGENT_ID}` placeholders stayed literal); its unique sections now compose
 * into `.har/README.md`. An installed copy is backed up and reported as residue
 * rather than deleted — users adapt these with real project knowledge.
 */
export const RETIRED_DOC_FILES = ['CLAUDE.agent.md'] as const;

/** Helper functions pre-1.0 templates shipped inside harness.env / lib/. */
const STOCK_ENV_FUNCTION_RE =
  /^(har_infra_enabled|har_pg|har_node_[a-z_]+|har_pkg_exec)$/;

/** Constants the stock pre-1.0 helper block defined — machinery, not config. */
const STOCK_ENV_HELPER_KEYS = new Set(['HAR_NODE_PACKAGE_MANAGERS']);

/** Pre-1.0 shell function definitions (any name) in harness.env. */
const ENV_FUNCTION_RE = /^([A-Za-z_][A-Za-z0-9_]*)\s*\(\)\s*\{?/;

/** Pre-1.0 boolean infra flags → compose service names. */
const LEGACY_INFRA_FLAGS: Record<string, string> = {
  HARNESS_INFRA_POSTGRES: 'db',
  HARNESS_INFRA_DB: 'db',
  HARNESS_INFRA_MINIO: 'minio',
  HARNESS_INFRA_MAILPIT: 'mailpit',
  HARNESS_INFRA_HEADLESS_BROWSER: 'headless-browser',
  HARNESS_INFRA_BROWSER: 'headless-browser',
};

/** Triplet prefix (HARNESS_<PREFIX>_PORT_*) → port lane name. */
const TRIPLET_LANES: Record<string, { lane: string; service: string }> = {
  DB: { lane: 'db', service: 'db' },
  MINIO: { lane: 'minio', service: 'minio' },
  MINIO_CONSOLE: { lane: 'minio-console', service: 'minio' },
  MAILPIT_WEB: { lane: 'mailpit-web', service: 'mailpit' },
  MAILPIT_SMTP: { lane: 'mailpit-smtp', service: 'mailpit' },
  BROWSER: { lane: 'browser', service: 'headless-browser' },
};

export type ResidueTarget = 'config' | 'stage' | 'hook' | 'plugin' | 'review';

export interface MigrationResidueItem {
  /** File (relative to .har/) or harness.env key the residue came from. */
  source: string;
  /** Backup path relative to .har/ when a backup will exist after apply. */
  backup?: string;
  reason: string;
  /** Where the customization should land in the 1.0 model. */
  target: ResidueTarget;
}

export interface HarnessEnvMigration {
  /** Purified pure-config content. */
  content: string;
  removedFunctions: string[];
  /** Function names that were project-specific, not shipped helpers. */
  customFunctions: string[];
  convertedFlags: string[];
  /** Services derived from legacy boolean flags / existing list. */
  services: string[];
  /** HARNESS_INFRA_PORT_LANES value derived from legacy triplets ('' if none). */
  portLanes: string;
  droppedTriplets: string[];
  /** Unknown HARNESS_* keys commented out (schema would reject them). */
  commentedKeys: string[];
  /** *_CMD keys whose legacy `true` no-op sentinel was normalized to "". */
  normalizedNoopCmds: string[];
  droppedShellLines: number;
}

export interface MigrationPlan {
  id: string;
  to: string;
  profile: HarnessProfile;
  /** Lifecycle entry scripts deleted (CLI/MCP are the only entry points). */
  deleteLifecycleScripts: string[];
  /** Runtime machinery deleted (superseded by the package runtime). */
  deleteMachinery: string[];
  /** Stock files new in the 1.0 surface, absent on disk — installed as-is. */
  installMissing: string[];
  /** Machinery files edited since the last finalize (flagged, still deleted). */
  editedMachinery: string[];
  /** Docs 1.0 retired that are still installed — backed up, lifted by the agent (#301). */
  retireDocs: string[];
  /**
   * Machinery still referenced by surviving user-owned scripts (stage scripts,
   * hooks) — retained instead of deleted so those scripts keep working, and
   * flagged as residue: rewrite the script against the 1.0 surface (WORK_DIR /
   * ENV_FILE / AGENT_ID are exported to stages), then delete the file.
   */
  retainMachinery: string[];
  env: HarnessEnvMigration | null;
  /**
   * verificationStages ids with no registered runnable stage. Pre-1.0, the
   * vendored verify.sh resolved these in its internal case table; the 1.0
   * registry is authoritative, so they are dropped from verificationStages
   * (keeping verify runnable) and re-registered via the MIGRATE prompt.
   */
  phantomVerificationIds: string[];
  residue: MigrationResidueItem[];
}

export interface AppliedMigration {
  plan: MigrationPlan;
  backupDir: string;
  /** Files written/deleted, relative to .har/. */
  written: string[];
  deleted: string[];
}

export interface HarnessMigration {
  id: string;
  /** Runtime version this migration brings a harness up to. */
  to: string;
  title: string;
  detect(repoPath: string): boolean;
  plan(repoPath: string): MigrationPlan;
  apply(repoPath: string, plan?: MigrationPlan): AppliedMigration;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Pre-1.0 markers in harness.env: shell functions or legacy port triplets. */
export function harnessEnvIsPre10(content: string): boolean {
  return (
    /^\s*(har_infra_enabled|har_pg|har_node_[a-z_]+|har_pkg_exec)\s*\(\)/m.test(content) ||
    /^export\s+HARNESS_[A-Z0-9_]+_PORT_(DEFAULT|SCAN_START|SCAN_END)=/m.test(content)
  );
}

function scriptIsVendored(harnessDir: string, script: string): boolean {
  const file = path.join(harnessDir, script);
  if (!fs.existsSync(file)) return false;
  const content = fs.readFileSync(file, 'utf8');
  // Managed shims delegate to `har env`; ejected scripts (#239) execute the
  // vendored runtime bundle the user owns — neither is pre-1.0 bash.
  return !content.includes('exec har env') && !content.includes('runtime/har.cjs');
}

/**
 * Shape detection for the pre-1.0 → 1.0 migration: vendored runtime bash in
 * the lifecycle scripts, leftover runtime machinery files, or a shell-era
 * harness.env. Ejected harnesses (#239) are user-owned 1.0 harnesses.
 */
export function isPre10Harness(repoPath: string): boolean {
  const resolved = path.resolve(repoPath);
  const harnessDir = getHarnessDir(resolved);
  if (!fs.existsSync(harnessDir)) return false;
  const manifest = readManifest(resolved);
  if (manifest?.ejected) return false;

  for (const file of LEGACY_MACHINERY_FILES) {
    if (fs.existsSync(path.join(harnessDir, file))) return true;
  }
  for (const script of MANAGED_SHIM_FILES) {
    if (scriptIsVendored(harnessDir, script)) return true;
  }
  const envPath = path.join(harnessDir, 'harness.env');
  if (fs.existsSync(envPath) && harnessEnvIsPre10(fs.readFileSync(envPath, 'utf8'))) {
    return true;
  }
  return false;
}

/**
 * Rewrite a pre-1.0 harness.env into pure schema-valid config:
 * - shell functions dropped (shipped helpers silently; custom ones as residue)
 * - legacy boolean infra flags → HARNESS_INFRA_SERVICES
 * - legacy port triplets → HARNESS_INFRA_PORT_LANES (enabled services only)
 * - unknown HARNESS_* keys commented out (the 1.0 schema rejects them)
 * - any other shell code dropped
 */
export function migrateHarnessEnvContent(original: string): HarnessEnvMigration {
  const lines = original.split('\n');
  const out: string[] = [];
  const removedFunctions: string[] = [];
  const convertedFlags: string[] = [];
  const droppedTriplets: string[] = [];
  const commentedKeys: string[] = [];
  const normalizedNoopCmds: string[] = [];
  const triplets: Record<string, { def?: number; start?: number; end?: number }> = {};
  let services: string[] = [];
  let hadServicesKey = false;
  let hasLanesKey = false;
  let droppedShellLines = 0;
  let fnDepth = 0;

  const ASSIGN_RE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

  for (const line of lines) {
    const trimmed = line.trim();
    if (fnDepth > 0) {
      fnDepth += (trimmed.match(/{/g) ?? []).length;
      fnDepth -= (trimmed.match(/}/g) ?? []).length;
      if (fnDepth < 0) fnDepth = 0;
      continue;
    }
    if (trimmed === '' || trimmed.startsWith('#')) {
      out.push(line);
      continue;
    }

    const fnMatch = trimmed.match(ENV_FUNCTION_RE);
    if (fnMatch) {
      removedFunctions.push(fnMatch[1]);
      fnDepth = Math.max(
        (trimmed.match(/{/g) ?? []).length - (trimmed.match(/}/g) ?? []).length,
        // `name() {` with the body on following lines still opens one block.
        trimmed.endsWith('{') ? 1 : 0,
      );
      continue;
    }

    const assign = trimmed.match(ASSIGN_RE);
    if (!assign) {
      droppedShellLines++;
      continue;
    }

    const [, key, rawValue] = assign;
    const value = rawValue.replace(/\s+#.*$/, '').trim().replace(/^["']|["']$/g, '');

    if (STOCK_ENV_HELPER_KEYS.has(key)) {
      droppedShellLines++;
      continue;
    }
    // Pre-1.0 templates used the shell no-op `true` as the "not configured"
    // placeholder for command values. The 1.0 convention is "" — the runtime
    // runs whatever a *_CMD holds, with no sentinel special cases.
    if (/^HARNESS_[A-Z0-9_]*CMD$/.test(key) && value === 'true') {
      normalizedNoopCmds.push(key);
      out.push(`export ${key}=""`);
      continue;
    }
    if (key === 'HARNESS_INFRA_SERVICES') {
      hadServicesKey = true;
      services = [...new Set([...services, ...value.split(/\s+/).filter(Boolean)])];
      out.push(line);
      continue;
    }
    if (key === 'HARNESS_INFRA_PORT_LANES') {
      hasLanesKey = true;
      out.push(line);
      continue;
    }
    if (key in LEGACY_INFRA_FLAGS) {
      convertedFlags.push(key);
      if (value === 'true') services = [...new Set([...services, LEGACY_INFRA_FLAGS[key]])];
      continue;
    }
    const tripletMatch = key.match(/^HARNESS_([A-Z0-9_]+)_PORT_(DEFAULT|SCAN_START|SCAN_END)$/);
    if (tripletMatch && LEGACY_PORT_TRIPLET_PATTERN.test(key)) {
      const [, prefix, part] = tripletMatch;
      const slot = (triplets[prefix] ??= {});
      const num = parseInt(value, 10);
      if (part === 'DEFAULT') slot.def = num;
      else if (part === 'SCAN_START') slot.start = num;
      else slot.end = num;
      droppedTriplets.push(key);
      continue;
    }
    if ((HARNESS_ENV_KNOWN_KEYS as string[]).includes(key) || !key.startsWith('HARNESS_')) {
      out.push(line);
      continue;
    }
    // Unknown HARNESS_* key — the 1.0 schema rejects it. Preserve the value as
    // a comment so a hook/stage that consumed it can be pointed at it.
    commentedKeys.push(key);
    out.push(`# [migrated 0.x — custom key, not in the 1.0 schema] ${trimmed}`);
    out.push(
      `#   → consume it from a lifecycle hook or stage script instead (see .har/MIGRATE-PROMPT.md)`,
    );
  }

  // Legacy flags → services list (only when the file had no list already).
  if (!hadServicesKey && services.length > 0) {
    out.push('', `export HARNESS_INFRA_SERVICES="${services.join(' ')}"`);
  }

  // Triplets → lanes, but only lanes whose service is actually enabled —
  // pre-1.0 templates shipped triplets for every service regardless of use.
  const laneEntries: string[] = [];
  if (!hasLanesKey) {
    for (const [prefix, mapping] of Object.entries(TRIPLET_LANES)) {
      const t = triplets[prefix];
      if (!t || t.def === undefined || t.start === undefined || t.end === undefined) continue;
      if (!services.includes(mapping.service)) continue;
      laneEntries.push(`${mapping.lane}=${t.def}:${t.start}-${t.end}`);
    }
    if (laneEntries.length > 0) {
      out.push('', `export HARNESS_INFRA_PORT_LANES="${laneEntries.join(' ')}"`);
    }
  }

  // Collapse runs of 3+ blank lines left by removed blocks.
  const content = out.join('\n').replace(/\n{3,}/g, '\n\n');

  return {
    content,
    removedFunctions,
    customFunctions: removedFunctions.filter((f) => !STOCK_ENV_FUNCTION_RE.test(f)),
    convertedFlags,
    services,
    portLanes: laneEntries.join(' '),
    droppedTriplets,
    commentedKeys,
    normalizedNoopCmds,
    droppedShellLines,
  };
}

const SCRIPT_RESIDUE_TARGET: Record<string, ResidueTarget> = {
  'launch.sh': 'hook',
  'teardown.sh': 'hook',
  'setup-infra.sh': 'hook',
  'verify.sh': 'stage',
  'preflight.sh': 'review',
  'agent-cli.sh': 'review',
};

function backupRel(file: string): string {
  return path.join(MIGRATE_BACKUP_DIR, file);
}

function buildPre10Plan(repoPath: string): MigrationPlan {
  const resolved = path.resolve(repoPath);
  const harnessDir = getHarnessDir(resolved);
  const manifest = readManifest(resolved);
  const profile: HarnessProfile = manifest?.profile ?? 'default';
  const composed = composeProfileTemplateMap(profile);
  const fileBaseline = manifest?.fileChecksums ?? {};

  const deleteLifecycleScripts: string[] = [];
  const residue: MigrationResidueItem[] = [];

  for (const script of MANAGED_SHIM_FILES) {
    if (!fs.existsSync(path.join(harnessDir, script))) continue;
    deleteLifecycleScripts.push(script);
    if (scriptIsVendored(harnessDir, script)) {
      const target = SCRIPT_RESIDUE_TARGET[script] ?? 'review';
      residue.push({
        source: script,
        backup: backupRel(script),
        target,
        reason:
          target === 'stage'
            ? 'Vendored verify pipeline deleted — project-specific verification steps belong in stages.json / .har/stages/ (bigger checks: a local plugin). Drive verify with `har env verify`.'
            : target === 'hook'
              ? 'Vendored script deleted — project-specific launch/teardown/infra behavior belongs in .har/hooks/ lifecycle hooks. Drive the slot with `har env launch` / `har env teardown`.'
              : 'Vendored script deleted — review the backup for project-specific behavior worth keeping. Invocation is `har env …`.',
      });
    }
  }

  // User-owned scripts that survive migration and may source machinery.
  // Anything the migration is about to overwrite with a shim does NOT survive,
  // so it must not retain machinery on its own behalf.
  const survivingScripts: string[] = [];
  for (const dir of ['stages', 'hooks']) {
    const full = path.join(harnessDir, dir);
    if (!fs.existsSync(full)) continue;
    for (const entry of fs.readdirSync(full)) {
      if (entry.endsWith('.sh') || entry.endsWith('.mjs')) survivingScripts.push(path.join(dir, entry));
    }
  }
  // Scripts sitting at the harness root count too (#297): a vendored attach.sh
  // sourcing agent-slot.sh was invisible here, so the migration happily deleted
  // the file it depended on. Lifecycle wrappers are deleted, not preserved.
  for (const entry of fs.readdirSync(harnessDir)) {
    if (!entry.endsWith('.sh')) continue;
    if ((MANAGED_SHIM_FILES as readonly string[]).includes(entry)) continue;
    if ((LEGACY_MACHINERY_FILES as readonly string[]).includes(entry)) continue;
    if (!fs.statSync(path.join(harnessDir, entry)).isFile()) continue;
    survivingScripts.push(entry);
  }
  // A machinery file counts as referenced only when a surviving script actually
  // loads or runs it (source/./bash/exec…) — a bare mention of the name (a log
  // line, an assertion, a comment) must not retain superseded machinery.
  const referencedBy = (machineryFile: string): string[] => {
    const base = path.basename(machineryFile).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const loadRe = new RegExp(
      `(?:\\bsource\\b|\\bbash\\b|\\bexec\\b|(?:^|[;&|(])\\s*\\.\\s)[^\\n#]*${base}`,
    );
    return survivingScripts.filter((script) =>
      fs
        .readFileSync(path.join(harnessDir, script), 'utf8')
        .split('\n')
        .some((line) => !/^\s*#/.test(line) && loadRe.test(line)),
    );
  };

  const retireDocs: string[] = [];
  for (const doc of RETIRED_DOC_FILES) {
    if (!fs.existsSync(path.join(harnessDir, doc))) continue;
    retireDocs.push(doc);
    residue.push({
      source: doc,
      backup: backupRel(doc),
      target: 'review',
      reason:
        '1.0 does not generate this file — the harness workflow lives in AGENTS.md and the harness detail in `.har/README.md`. Move any project-specific content (readiness/agent-usable definition, credentials and default data, project commands, architecture notes) into `.har/README.md`, then delete `.har/' +
        doc +
        '`.',
    });
  }

  const deleteMachinery: string[] = [];
  const editedMachinery: string[] = [];
  const retainMachinery: string[] = [];
  for (const file of LEGACY_MACHINERY_FILES) {
    const full = path.join(harnessDir, file);
    if (!fs.existsSync(full)) continue;
    const refs = referencedBy(file);
    if (refs.length > 0) {
      // Deleting it would break the referencing script mid-migration — keep
      // it and put the rewrite on the prompt instead (classify-and-lift).
      retainMachinery.push(file);
      residue.push({
        source: file,
        backup: backupRel(file),
        target: 'stage',
        reason: `Runtime machinery superseded by the package runtime, but still sourced by ${refs.map((r) => `\`${r}\``).join(', ')} — rewrite the script(s) against the 1.0 stage surface (stages receive exported WORK_DIR, ENV_FILE, AGENT_ID, HAR_HARNESS_DIR; the slot env file is already sourced), then delete .har/${file}.`,
      });
      continue;
    }
    deleteMachinery.push(file);
    const recorded = fileBaseline[file];
    const installed = computeFileChecksum(fs.readFileSync(full, 'utf8'));
    if (recorded !== undefined && installed !== recorded) {
      editedMachinery.push(file);
      residue.push({
        source: file,
        backup: backupRel(file),
        target: 'hook',
        reason:
          'Runtime machinery superseded by the package runtime, but this copy was edited since the last finalize — lift the patch into a lifecycle hook (or `har env eject` for full runtime ownership).',
      });
    }
  }

  let env: HarnessEnvMigration | null = null;
  const envPath = path.join(harnessDir, 'harness.env');
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf8');
    if (harnessEnvIsPre10(content) || migrateHarnessEnvContent(content).commentedKeys.length > 0) {
      env = migrateHarnessEnvContent(content);
      for (const fn of env.customFunctions) {
        residue.push({
          source: `harness.env: ${fn}()`,
          backup: backupRel('harness.env'),
          target: 'hook',
          reason:
            'Project-defined shell function removed from harness.env (pure config in 1.0) — move the logic into a lifecycle hook or stage script.',
        });
      }
      for (const key of env.commentedKeys) {
        residue.push({
          source: `harness.env: ${key}`,
          backup: backupRel('harness.env'),
          target: 'config',
          reason:
            'Custom key commented out (not in the 1.0 schema) — the hook/stage that consumes it can define the value locally, or map it onto a schema key.',
        });
      }
    }
  }

  // Stock files the 1.0 profile ships that a pre-1.0 harness has never had
  // (e.g. stages/readiness.sh) — without them drift reports them missing
  // forever and default stages that need them are silently skipped.
  const installMissing: string[] = [];
  for (const file of composed.keys()) {
    if ((MANAGED_SHIM_FILES as readonly string[]).includes(file)) continue;
    // gitignore.template is generator input (installed as .gitignore), not a
    // harness file itself.
    if (file === 'gitignore.template') continue;
    if (!fs.existsSync(path.join(harnessDir, file))) installMissing.push(file);
  }

  let phantomVerificationIds: string[] = [];
  try {
    phantomVerificationIds = findPhantomVerificationStageIds(readStageRegistry(resolved));
  } catch {
    // Unparseable stages.json is a doctor error, not a migration concern.
  }
  for (const id of phantomVerificationIds) {
    residue.push({
      source: `stages.json: verificationStages "${id}"`,
      backup: backupRel('verify.sh'),
      target: 'stage',
      reason:
        'Verification id with no registered stage — its command lived in the vendored verify.sh case table. Re-register it as a stages.json command stage (or a local plugin) with the command from the backup, or drop it if the packaged runtime already covers it.',
    });
  }

  return {
    id: 'config-surface',
    to: HARNESS_RUNTIME_VERSION,
    profile,
    deleteLifecycleScripts,
    deleteMachinery,
    retireDocs,
    installMissing,
    editedMachinery,
    retainMachinery,
    env,
    phantomVerificationIds,
    residue,
  };
}

function applyPre10Plan(repoPath: string, plan?: MigrationPlan): AppliedMigration {
  const resolved = path.resolve(repoPath);
  const harnessDir = getHarnessDir(resolved);
  const effective = plan ?? buildPre10Plan(resolved);
  const backupDir = path.join(harnessDir, MIGRATE_BACKUP_DIR);
  fs.mkdirSync(backupDir, { recursive: true });

  const backup = (file: string): void => {
    const src = path.join(harnessDir, file);
    if (!fs.existsSync(src)) return;
    const dest = path.join(backupDir, file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  };

  const written: string[] = [];
  const deleted: string[] = [];
  const projectName = path.basename(resolved).toLowerCase().replace(/[^a-z0-9]/g, '_');
  const composed = composeProfileTemplateMap(effective.profile);

  // 1. Vendored (or leftover managed) lifecycle wrappers → gone (#314).
  // CLI and MCP are the only entry points; stages dispatch by kind.
  for (const script of effective.deleteLifecycleScripts) {
    backup(script);
    fs.rmSync(path.join(harnessDir, script), { force: true });
    deleted.push(script);
  }
  if (stripLifecycleShimCommands(resolved)) {
    written.push('stages.json');
  }

  // 2. Runtime machinery → gone (the package runtime is the single implementation).
  for (const file of effective.deleteMachinery) {
    backup(file);
    fs.rmSync(path.join(harnessDir, file), { force: true });
    deleted.push(file);
  }
  // 2a. Retired docs (#301): backed up, left on disk. The prompt tells the agent
  // to lift project-specific content into README.md and then delete the file —
  // yanking a doc the user wrote out from under them mid-migration is worse.
  for (const doc of effective.retireDocs ?? []) {
    backup(doc);
  }

  const libDir = path.join(harnessDir, 'lib');
  if (fs.existsSync(libDir) && fs.readdirSync(libDir).length === 0) {
    fs.rmdirSync(libDir);
    deleted.push('lib/');
  }

  // 2b. Stock files new in the 1.0 surface — install, never overwrite.
  for (const file of effective.installMissing ?? []) {
    const source = composed.get(file);
    if (!source) continue;
    const dest = path.join(harnessDir, file);
    if (fs.existsSync(dest)) continue;
    const rendered = substituteTemplateTokens(readComposedTemplateContent(source), projectName);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, rendered);
    if (/\.(sh|mjs)$/.test(file)) fs.chmodSync(dest, 0o755);
    written.push(file);
  }

  // 3. verificationStages ids the registry cannot resolve (their commands
  // lived in the vendored verify.sh) are dropped so verify --full keeps
  // running; the MIGRATE prompt drives their re-registration as stages.
  if (effective.phantomVerificationIds.length > 0) {
    backup('stages.json');
    const registry = readStageRegistry(resolved);
    const drop = new Set(effective.phantomVerificationIds);
    writeStageRegistry(resolved, {
      ...registry,
      verificationStages: (registry.verificationStages ?? []).filter((id) => !drop.has(id)),
    });
    written.push('stages.json');
  }

  // 4. harness.env → pure schema-valid config.
  if (effective.env) {
    backup('harness.env');
    fs.writeFileSync(path.join(harnessDir, 'harness.env'), effective.env.content);
    written.push('harness.env');
  }

  // 5. Stamp the manifest and re-baseline both drift signals: post-migration
  // drift must report only what the user genuinely adapts from here on.
  const manifest = readManifest(resolved);
  if (manifest) {
    writeManifest(resolved, {
      ...manifest,
      runtimeVersion: HARNESS_RUNTIME_VERSION,
      migratedFrom: manifest.runtimeVersion ?? 'pre-1.0',
      migratedAt: new Date().toISOString(),
      fileChecksums: computeHarnessChecksums(harnessDir),
      templateChecksums: computeTemplateChecksums(resolved, effective.profile),
      updatedAt: new Date().toISOString(),
    });
  }

  fs.writeFileSync(
    path.join(harnessDir, MIGRATE_PLAN_FILE),
    JSON.stringify({ ...effective, appliedAt: new Date().toISOString() }, null, 2) + '\n',
  );

  return { plan: effective, backupDir, written, deleted };
}

export const PRE_1_0_MIGRATION: HarnessMigration = {
  id: 'config-surface',
  to: HARNESS_RUNTIME_VERSION,
  title: '.har/ becomes a configuration surface (pre-1.0 → 1.0)',
  detect: isPre10Harness,
  plan: buildPre10Plan,
  apply: applyPre10Plan,
};

/**
 * The migration registry, keyed on the runtime version each migration brings
 * a harness up to. Platform-shape upgrades belong here as code — never as
 * prose checklists in adaptation prompts.
 */
export const HARNESS_MIGRATIONS: HarnessMigration[] = [PRE_1_0_MIGRATION];

/**
 * Migrations this harness still needs, in registry (version) order. Shape
 * detection is authoritative: a stamped runtimeVersion never masks a harness
 * that still has the old shape on disk (e.g. a finalize ran before the
 * migration did — the backups and prompt must survive that).
 */
export function pendingMigrations(repoPath: string): HarnessMigration[] {
  return HARNESS_MIGRATIONS.filter((m) => m.detect(repoPath)).sort((a, b) =>
    compareVersions(a.to, b.to),
  );
}

/** Write the (not yet applied) plan to .har/migrate/plan.json for inspection. */
export function writeMigrationPlan(repoPath: string, plan: MigrationPlan): string {
  const harnessDir = getHarnessDir(path.resolve(repoPath));
  const planPath = path.join(harnessDir, MIGRATE_PLAN_FILE);
  fs.mkdirSync(path.dirname(planPath), { recursive: true });
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2) + '\n');
  return planPath;
}

/** Remove migration artifacts (plan, backups, prompt) — called by finalize. */
export function removeMigrationArtifacts(repoPath: string): void {
  const harnessDir = getHarnessDir(path.resolve(repoPath));
  fs.rmSync(path.join(harnessDir, MIGRATE_DIR), { recursive: true, force: true });
  fs.rmSync(path.join(harnessDir, 'MIGRATE-PROMPT.md'), { force: true });
}
