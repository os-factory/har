import * as fs from 'fs';
import * as path from 'path';
import { info, success, warn } from '../utils/logging';
import { harnessExists } from './parser';
import { readLineLedger, upsertLineLedgerEntry } from './line-ledger';
import {
  ensureHarLocalIgnored,
  HAR_LOCAL_DIR,
  isUnderHarDir,
  LINE_SCOPES,
  linesDirRel,
  personalFileDest,
  personalHarRoot,
  resolveRepoFilePath,
  scopeRoot,
  type LineScope,
} from './line-scope';
import { buildLineAdaptationPrompt, writeLineAdaptationPrompt } from './line-prompt';
import {
  cleanupResolvedLine,
  resolveLineSource,
  type LineSourceKind,
} from './line-resolve';
import { findManifestPath } from './bundle-resolve';
import { LINE_BUNDLE_KIND, LINE_MANIFEST_FILES } from './schema';
import type { HarnessStage, LineManifest, LineProgram } from './schema';
import { LineManifestSchema, LineProgramSchema } from './schema';
import { stampManifestWriter } from './manifest';
import {
  readCommittedStageRegistry,
  readStageOverlay,
  readStageRegistry,
  STAGE_OVERLAY_FILE,
  writeStageOverlay,
  writeStageRegistry,
} from './stages';
import { LINE_BUNDLE_CONFIG } from './line-resolve';
import { DEFAULT_HAR_DIR } from './manifest';

export interface ApplyLineOptions {
  force?: boolean;
  /** Install spec when different from the resolved line id. */
  spec?: string;
  /** `personal` installs under the gitignored `.har/local/` (default: `team`). */
  scope?: LineScope;
}

export interface ApplyLineResult {
  lineId: string;
  title: string;
  scope: LineScope;
  /** Stages registered in .har/stages.json — registered only, never on verify. */
  stageIds: string[];
  filesWritten: string[];
  warnings: string[];
  nextSteps: string[];
  /** Repo-relative path of the installed program. */
  programPath: string;
  docsPath?: string;
  source: LineSourceKind;
  adaptPromptPath: string;
  /** Station ids in order, for the handoff summary. */
  stationIds: string[];
  /** First station whose cumulative gate is non-empty — what to run next. */
  firstGatedStationId: string;
}

/** Repo-relative home of an installed line. */
export function lineDirRel(lineId: string, scope: LineScope = 'team'): string {
  return `${linesDirRel(scope)}/${lineId}`;
}

export function lineProgramPathRel(lineId: string, scope: LineScope = 'team'): string {
  return `${lineDirRel(lineId, scope)}/line.json`;
}

/**
 * Scopes a line id is installed in: a ledger entry in that scope, or a program
 * on disk at that scope's home. More than one is a clash the caller reports.
 */
export function installedLineScopes(repoPath: string, lineId: string): LineScope[] {
  const resolved = path.resolve(repoPath);
  return LINE_SCOPES.filter(
    (scope) =>
      (readLineLedger(resolved, scope)?.lines.some((l) => l.id === lineId) ?? false) ||
      fs.existsSync(path.join(scopeRoot(resolved, scope), lineProgramPathRel(lineId, scope))),
  );
}

export function lineScopeClashMessage(lineId: string): string {
  return (
    `Line "${lineId}" is installed as both team (${lineDirRel(lineId, 'team')}) and personal ` +
    `(${lineDirRel(lineId, 'personal')}). Remove one of them — an id must be unique across scopes.`
  );
}

/** Which scope holds a line, or null when it is not installed. Throws on a clash. */
export function locateInstalledLine(repoPath: string, lineId: string): LineScope | null {
  const scopes = installedLineScopes(repoPath, lineId);
  if (scopes.length > 1) throw new Error(lineScopeClashMessage(lineId));
  return scopes[0] ?? null;
}

/**
 * Read a line manifest from a bundle directory.
 *
 * Poka-yoke (#304 decision 4): a verification-plugin manifest resolved here is
 * rejected with a pointer at `har env add-plugin`, and vice versa in
 * `plugins.ts`. The two apply paths are deliberately not interchangeable —
 * `add-plugin` appends to `verificationStages`, `line add` must never do that.
 */
export function readLineManifestFromDir(bundleDir: string, expectedId?: string): LineManifest {
  const manifestPath = findManifestPath(bundleDir, LINE_BUNDLE_CONFIG);
  if (!manifestPath) {
    throw new Error(`No ${LINE_MANIFEST_FILES.join(' or ')} in ${bundleDir}`);
  }

  const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  if (raw.kind !== LINE_BUNDLE_KIND) {
    throw new Error(
      `${path.basename(manifestPath)} is not a factory line bundle (missing "kind": "line"). ` +
        'Verification plugins install with: har env add-plugin <spec>',
    );
  }

  const parsed = LineManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid line manifest: ${parsed.error.message}`);
  }
  if (expectedId && parsed.data.id !== expectedId) {
    throw new Error(`Line manifest id mismatch: expected ${expectedId}, got ${parsed.data.id}`);
  }
  return parsed.data;
}

export function readLineProgramFromDir(bundleDir: string, manifest: LineManifest): LineProgram {
  const programPath = path.join(bundleDir, manifest.program);
  if (!fs.existsSync(programPath)) {
    throw new Error(`Line program missing: ${manifest.program} (referenced by line.manifest.json)`);
  }
  const parsed = LineProgramSchema.safeParse(JSON.parse(fs.readFileSync(programPath, 'utf8')));
  if (!parsed.success) {
    throw new Error(`Invalid line program (${manifest.program}): ${parsed.error.message}`);
  }
  if (parsed.data.id !== manifest.id) {
    throw new Error(
      `Line program id "${parsed.data.id}" does not match manifest id "${manifest.id}"`,
    );
  }
  return parsed.data;
}

/**
 * Read the installed program for a line id, or null when not installed.
 * Without `scope` the line is located across both scopes (throws on a clash).
 */
export function readInstalledLineProgram(
  repoPath: string,
  lineId: string,
  scope?: LineScope,
): LineProgram | null {
  const where = scope ?? locateInstalledLine(repoPath, lineId);
  if (!where) return null;
  const programPath = path.join(scopeRoot(repoPath, where), lineProgramPathRel(lineId, where));
  if (!fs.existsSync(programPath)) return null;
  const parsed = LineProgramSchema.safeParse(JSON.parse(fs.readFileSync(programPath, 'utf8')));
  return parsed.success ? parsed.data : null;
}

function ensureParentDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

/**
 * Personal lines keep everything they write inside the gitignored `.har/local/`:
 * bundle files under `.har/` move to `.har/local/…`, and a stage whose script
 * is one of those files points at the moved copy. The bundle itself is not
 * changed, so the same bundle installs as team or personal.
 */
function scopeBundle(
  manifest: LineManifest,
  scope: LineScope,
): { files: LineManifest['files']; stages: HarnessStage[]; warnings: string[] } {
  if (scope === 'team') {
    return { files: manifest.files, stages: manifest.stages, warnings: [] };
  }
  const warnings: string[] = [];
  const movedScripts = new Map<string, string>();
  const files = manifest.files.map((file) => {
    if (!isUnderHarDir(file.dest)) {
      warnings.push(
        `${file.dest} is outside .har/, so it is not gitignored — this personal line still writes it to the shared tree.`,
      );
      return file;
    }
    const dest = personalFileDest(file.dest);
    const harPrefix = `${DEFAULT_HAR_DIR}/`;
    movedScripts.set(
      file.dest.replace(/^\.\//, '').slice(harPrefix.length),
      dest.slice(harPrefix.length),
    );
    return { ...file, dest };
  });
  const stages = manifest.stages.map((stage) => {
    const moved = stage.script ? movedScripts.get(stage.script.replace(/^\.\//, '')) : undefined;
    return moved ? { ...stage, script: moved } : stage;
  });
  return { files, stages, warnings };
}

function copyBundleFile(
  bundleDir: string,
  file: { src: string; dest: string; executable?: boolean },
  repoPath: string,
  force: boolean,
): string {
  const srcPath = path.join(bundleDir, file.src);
  const destPath = resolveRepoFilePath(repoPath, file.dest);

  if (!fs.existsSync(srcPath)) {
    throw new Error(`Line file missing: ${file.src}`);
  }
  if (path.resolve(srcPath) === path.resolve(destPath)) {
    // Authoring in place (.har/lines/<id>/ installed onto itself) — nothing to copy.
    return file.dest;
  }
  if (fs.existsSync(destPath) && !force) {
    throw new Error(
      `File already exists: ${file.dest}. Use --force to overwrite or remove it first.`,
    );
  }

  ensureParentDir(destPath);
  fs.copyFileSync(srcPath, destPath);
  if (file.executable) {
    fs.chmodSync(destPath, 0o755);
  }
  return file.dest;
}

/**
 * Register stages WITHOUT touching `verificationStages`.
 *
 * Deliberately not `patchStageRegistry` from plugins.ts: that function's whole
 * job is appending to `verificationStages`. Calling it with an empty array and
 * hoping is the anti-pattern #304 calls out, so line apply has its own writer
 * plus an assertion that the verify plan is byte-identical afterwards.
 */
function registerStagesOnly(
  repoPath: string,
  stages: HarnessStage[],
  force: boolean,
  scope: LineScope,
): void {
  if (stages.length === 0) return;
  if (scope === 'personal') {
    registerPersonalStages(repoPath, stages, force);
    return;
  }

  // Committed writes start from the committed file only (never the merged read).
  const registry = readCommittedStageRegistry(repoPath);
  const before = JSON.stringify(registry.verificationStages ?? null);

  const overlayIds = new Set(readStageOverlay(repoPath)?.stages.map((s) => s.id) ?? []);
  const personalClash = stages.filter((s) => overlayIds.has(s.id)).map((s) => s.id);
  if (personalClash.length > 0) {
    throw new Error(
      `Stage(s) ${personalClash.join(', ')} are registered by a personal line in .har/${STAGE_OVERLAY_FILE}. ` +
        'A team stage cannot share an id with a personal one — remove the personal line first.',
    );
  }

  let nextStages = [...registry.stages];
  for (const stage of stages) {
    const existing = nextStages.find((s) => s.id === stage.id);
    if (existing && !force) {
      throw new Error(
        `Stage "${stage.id}" already registered in .har/stages.json. Use --force to replace.`,
      );
    }
    nextStages = existing
      ? nextStages.map((s) => (s.id === stage.id ? stage : s))
      : [...nextStages, stage];
  }

  const updated = { ...registry, stages: nextStages };
  const after = JSON.stringify(updated.verificationStages ?? null);
  if (before !== after) {
    throw new Error(
      'Refusing to write: applying a line changed verificationStages. ' +
        'Line gate stages are opt-in and run via `har line gate`.',
    );
  }

  writeStageRegistry(repoPath, updated);
}

/** A committed stage that a personal install put there before the overlay existed. */
function isLegacyPersonalStage(stage: HarnessStage): boolean {
  return (stage.script ?? '').replace(/^\.\//, '').startsWith(`${HAR_LOCAL_DIR}/`);
}

/**
 * Personal line stages go to the gitignored overlay `.har/local/stages.json`,
 * leaving the committed `.har/stages.json` byte-identical. The overlay schema
 * holds `stages` only, so it cannot touch the verify plan.
 *
 * A committed stage with the same id is a clash — except one whose script is
 * under `.har/local/`: that is this line's stage from a personal install made
 * before the overlay existed, and it moves to the overlay.
 */
function registerPersonalStages(repoPath: string, stages: HarnessStage[], force: boolean): void {
  const ids = new Set(stages.map((s) => s.id));
  const committed = readCommittedStageRegistry(repoPath);
  const inCommitted = committed.stages.filter((s) => ids.has(s.id));
  const teamClash = inCommitted.filter((s) => !isLegacyPersonalStage(s)).map((s) => s.id);
  if (teamClash.length > 0) {
    throw new Error(
      `Stage(s) ${teamClash.join(', ')} are already registered in the committed .har/stages.json. ` +
        'A personal stage cannot share an id with a team one.',
    );
  }

  const overlay = readStageOverlay(repoPath) ?? { version: '1', stages: [] };
  let nextStages = [...overlay.stages];
  for (const stage of stages) {
    const existing = nextStages.find((s) => s.id === stage.id);
    if (existing && !force) {
      throw new Error(
        `Stage "${stage.id}" already registered in .har/${STAGE_OVERLAY_FILE}. Use --force to replace.`,
      );
    }
    nextStages = existing
      ? nextStages.map((s) => (s.id === stage.id ? stage : s))
      : [...nextStages, stage];
  }

  // Move legacy entries out of the committed file first, so the overlay write
  // never leaves the same id in both places.
  if (inCommitted.length > 0) {
    writeStageRegistry(repoPath, {
      ...committed,
      stages: committed.stages.filter((s) => !ids.has(s.id)),
    });
    warn(
      `  Moved ${inCommitted.map((s) => s.id).join(', ')} from .har/stages.json to .har/${STAGE_OVERLAY_FILE} — ` +
        'commit the .har/stages.json change so teammates stop seeing a personal stage.',
    );
  }
  writeStageOverlay(repoPath, { ...overlay, stages: nextStages });
}

function assertGateStagesResolvable(program: LineProgram, registeredIds: string[], repoPath: string): string[] {
  const warnings: string[] = [];
  const registry = readStageRegistry(repoPath);
  const known = new Set([...registry.stages.map((s) => s.id), ...registeredIds]);
  for (const stage of program.gate.stages) {
    if (!known.has(stage.id)) {
      warnings.push(
        `gate stage "${stage.id}" (from ${stage.fromStation}) is not registered in .har/stages.json — ` +
          'install the plugin that provides it, or add it to the line bundle.',
      );
    }
  }
  return warnings;
}

function personalizeStep(step: string, manifest: LineManifest, scope: LineScope): string {
  if (scope === 'team') return step;
  let out = step.split(`${lineDirRel(manifest.id, 'team')}/`).join(`${lineDirRel(manifest.id, 'personal')}/`);
  for (const file of manifest.files) {
    if (!isUnderHarDir(file.dest)) continue;
    const teamPath = file.dest.replace(/\\/g, '/').replace(/^\.\//, '');
    out = out.split(teamPath).join(personalFileDest(teamPath));
  }
  return out;
}

function applyLineFromDir(
  repoPath: string,
  bundleDir: string,
  options: ApplyLineOptions,
  meta: { source: LineSourceKind; spec: string; version?: string },
): ApplyLineResult {
  const resolved = path.resolve(repoPath);
  const force = options.force ?? false;
  const scope: LineScope = options.scope ?? 'team';
  const warnings: string[] = [];
  const filesWritten: string[] = [];

  if (!harnessExists(resolved)) {
    throw new Error('No .har/ harness found. Run "har onboard" first.');
  }

  const manifest = readLineManifestFromDir(bundleDir);
  const program = readLineProgramFromDir(bundleDir, manifest);

  const otherScope = installedLineScopes(resolved, manifest.id).find((s) => s !== scope);
  if (otherScope) {
    throw new Error(
      `Line "${manifest.id}" is already installed as ${otherScope} (${lineDirRel(manifest.id, otherScope)}). ` +
        'An id must be unique across team and personal lines — remove that one first, or install under a different id.',
    );
  }
  if (scope === 'personal') {
    ensureHarLocalIgnored(personalHarRoot(resolved));
  }

  const scoped = scopeBundle(manifest, scope);
  warnings.push(...scoped.warnings);
  const stages = scoped.stages;
  const stageIds = stages.map((s) => s.id);

  // Snapshot the verify plan across the whole apply, not just the registry write.
  const verificationBefore = JSON.stringify(readStageRegistry(resolved).verificationStages ?? null);

  for (const file of scoped.files) {
    filesWritten.push(copyBundleFile(bundleDir, file, resolved, force));
  }

  // The program always lands at <scope home>/<id>/line.json, whatever the
  // bundle called it, so `har line describe` has one place to look.
  const programPathRel = lineProgramPathRel(manifest.id, scope);
  const programDest = path.join(scopeRoot(resolved, scope), programPathRel);
  const programSrc = path.join(bundleDir, manifest.program);
  if (path.resolve(programSrc) !== path.resolve(programDest)) {
    if (fs.existsSync(programDest) && !force) {
      throw new Error(`Line already installed: ${programPathRel}. Use --force to replace.`);
    }
    ensureParentDir(programDest);
    fs.copyFileSync(programSrc, programDest);
  }
  filesWritten.push(programPathRel);

  // Keep the manifest next to the program so a bare id re-resolves locally.
  const manifestDest = path.join(scopeRoot(resolved, scope), lineDirRel(manifest.id, scope), 'line.manifest.json');
  const manifestSrc = findManifestPath(bundleDir, LINE_BUNDLE_CONFIG) as string;
  if (path.resolve(manifestSrc) !== path.resolve(manifestDest)) {
    ensureParentDir(manifestDest);
    fs.copyFileSync(manifestSrc, manifestDest);
    filesWritten.push(`${lineDirRel(manifest.id, scope)}/line.manifest.json`);
  }

  registerStagesOnly(resolved, stages, force, scope);

  const verificationAfter = JSON.stringify(readStageRegistry(resolved).verificationStages ?? null);
  if (verificationBefore !== verificationAfter) {
    throw new Error(
      'Line apply changed verificationStages — this is a bug. ' +
        'Line gate stages must stay off `har env verify --full`.',
    );
  }

  warnings.push(...assertGateStagesResolvable(program, stageIds, resolved));

  upsertLineLedgerEntry(
    resolved,
    {
      id: manifest.id,
      source: meta.source,
      spec: meta.spec,
      version: meta.version,
      stageIds,
      programPath: programPathRel,
      installedAt: new Date().toISOString(),
    },
    scope,
  );

  // Point at the first station that actually has gate stages — suggesting the
  // first station runs an empty gate and reads like the install did nothing.
  const firstGatedStation =
    program.stations.find((station) =>
      program.gate.stages.some((stage) => stage.fromStation === station.id),
    )?.id ?? program.stations[0].id;

  // A bundle's own next steps name its files' team paths; a personal install
  // moved them under .har/local/, so point the steps there too.
  const nextSteps =
    manifest.nextSteps.length > 0
      ? manifest.nextSteps.map((step) => personalizeStep(step, manifest, scope))
      : [
          `har line describe ${manifest.id}`,
          `har line gate ${firstGatedStation} --line ${manifest.id}`,
          `Adapt the program: ${programPathRel}`,
        ];

  const partial = {
    lineId: manifest.id,
    title: manifest.title ?? program.title,
    scope,
    stageIds,
    filesWritten,
    warnings,
    nextSteps,
    programPath: programPathRel,
    docsPath: manifest.docsPath,
    source: meta.source,
    stationIds: program.stations.map((s) => s.id),
    firstGatedStationId: firstGatedStation,
  };

  const promptAbsPath = writeLineAdaptationPrompt(
    resolved,
    manifest.id,
    buildLineAdaptationPrompt(resolved, program, { ...partial, adaptPromptPath: '' }),
    scope,
  );
  const adaptPromptPath = path.relative(resolved, promptAbsPath);
  // A personal install must not touch committed files beyond the stage registry.
  if (scope === 'team') {
    stampManifestWriter(resolved);
  }

  success(`Applied line: ${manifest.id}${scope === 'personal' ? ' (personal — gitignored)' : ''}`);
  info(`Stations: ${partial.stationIds.join(' → ')}`);
  info(
    stageIds.length > 0
      ? `Registered stage(s) (NOT on verify): ${stageIds.join(', ')}`
      : 'No extra stages registered',
  );
  for (const file of filesWritten) {
    info(`  + ${file}`);
  }
  info(`  + ${adaptPromptPath} (adaptation prompt for your coding agent)`);
  for (const warning of warnings) {
    warn(`  ⚠ ${warning}`);
  }

  return { ...partial, adaptPromptPath };
}

/** Install a factory line by bundled id, local id, path, npm package, or git URL. */
export function applyLine(
  repoPath: string,
  lineSpec: string,
  options: ApplyLineOptions = {},
): ApplyLineResult {
  const spec = options.spec ?? lineSpec;
  const source = resolveLineSource(spec, repoPath, options.scope ?? 'team');
  try {
    return applyLineFromDir(repoPath, source.dir, options, {
      source: source.kind,
      spec: source.spec,
      version: source.version,
    });
  } finally {
    cleanupResolvedLine(source);
  }
}
