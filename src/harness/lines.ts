import * as fs from 'fs';
import * as path from 'path';
import { info, success, warn } from '../utils/logging';
import { harnessExists } from './parser';
import { upsertLineLedgerEntry } from './line-ledger';
import { buildLineAdaptationPrompt, writeLineAdaptationPrompt } from './line-prompt';
import {
  cleanupResolvedLine,
  LOCAL_LINES_DIR,
  resolveLineSource,
  type LineSourceKind,
} from './line-resolve';
import { findManifestPath } from './bundle-resolve';
import { LINE_BUNDLE_KIND, LINE_MANIFEST_FILES } from './schema';
import type { HarnessStage, LineManifest, LineProgram } from './schema';
import { LineManifestSchema, LineProgramSchema } from './schema';
import { stampManifestWriter } from './manifest';
import { readStageRegistry, writeStageRegistry } from './stages';
import { LINE_BUNDLE_CONFIG } from './line-resolve';

export interface ApplyLineOptions {
  force?: boolean;
  /** Install spec when different from the resolved line id. */
  spec?: string;
}

export interface ApplyLineResult {
  lineId: string;
  title: string;
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
export function lineDirRel(lineId: string): string {
  return `${LOCAL_LINES_DIR}/${lineId}`;
}

export function lineProgramPathRel(lineId: string): string {
  return `${lineDirRel(lineId)}/line.json`;
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

/** Read the installed program for a line id, or null when not installed. */
export function readInstalledLineProgram(repoPath: string, lineId: string): LineProgram | null {
  const programPath = path.join(path.resolve(repoPath), lineProgramPathRel(lineId));
  if (!fs.existsSync(programPath)) return null;
  const parsed = LineProgramSchema.safeParse(JSON.parse(fs.readFileSync(programPath, 'utf8')));
  return parsed.success ? parsed.data : null;
}

function ensureParentDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function copyBundleFile(
  bundleDir: string,
  file: { src: string; dest: string; executable?: boolean },
  repoPath: string,
  force: boolean,
): string {
  const srcPath = path.join(bundleDir, file.src);
  const destPath = path.join(repoPath, file.dest);

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
function registerStagesOnly(repoPath: string, stages: HarnessStage[], force: boolean): void {
  if (stages.length === 0) return;

  const registry = readStageRegistry(repoPath);
  const before = JSON.stringify(registry.verificationStages ?? null);

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

function applyLineFromDir(
  repoPath: string,
  bundleDir: string,
  options: ApplyLineOptions,
  meta: { source: LineSourceKind; spec: string; version?: string },
): ApplyLineResult {
  const resolved = path.resolve(repoPath);
  const force = options.force ?? false;
  const warnings: string[] = [];
  const filesWritten: string[] = [];

  if (!harnessExists(resolved)) {
    throw new Error('No .har/ harness found. Run "har onboard" first.');
  }

  const manifest = readLineManifestFromDir(bundleDir);
  const program = readLineProgramFromDir(bundleDir, manifest);
  const stages = manifest.stages;
  const stageIds = stages.map((s) => s.id);

  // Snapshot the verify plan across the whole apply, not just the registry write.
  const verificationBefore = JSON.stringify(readStageRegistry(resolved).verificationStages ?? null);

  for (const file of manifest.files) {
    filesWritten.push(copyBundleFile(bundleDir, file, resolved, force));
  }

  // The program always lands at .har/lines/<id>/line.json, whatever the bundle
  // called it, so `har line status` has one place to look.
  const programDest = path.join(resolved, lineProgramPathRel(manifest.id));
  const programSrc = path.join(bundleDir, manifest.program);
  if (path.resolve(programSrc) !== path.resolve(programDest)) {
    if (fs.existsSync(programDest) && !force) {
      throw new Error(
        `Line already installed: ${lineProgramPathRel(manifest.id)}. Use --force to replace.`,
      );
    }
    ensureParentDir(programDest);
    fs.copyFileSync(programSrc, programDest);
  }
  filesWritten.push(lineProgramPathRel(manifest.id));

  // Keep the manifest next to the program so a bare id re-resolves locally.
  const manifestDest = path.join(resolved, lineDirRel(manifest.id), 'line.manifest.json');
  const manifestSrc = findManifestPath(bundleDir, LINE_BUNDLE_CONFIG) as string;
  if (path.resolve(manifestSrc) !== path.resolve(manifestDest)) {
    ensureParentDir(manifestDest);
    fs.copyFileSync(manifestSrc, manifestDest);
    filesWritten.push(`${lineDirRel(manifest.id)}/line.manifest.json`);
  }

  registerStagesOnly(resolved, stages, force);

  const verificationAfter = JSON.stringify(readStageRegistry(resolved).verificationStages ?? null);
  if (verificationBefore !== verificationAfter) {
    throw new Error(
      'Line apply changed verificationStages — this is a bug. ' +
        'Line gate stages must stay off `har env verify --full`.',
    );
  }

  warnings.push(...assertGateStagesResolvable(program, stageIds, resolved));

  upsertLineLedgerEntry(resolved, {
    id: manifest.id,
    source: meta.source,
    spec: meta.spec,
    version: meta.version,
    stageIds,
    programPath: lineProgramPathRel(manifest.id),
    installedAt: new Date().toISOString(),
  });

  // Point at the first station that actually has gate stages — suggesting the
  // first station runs an empty gate and reads like the install did nothing.
  const firstGatedStation =
    program.stations.find((station) =>
      program.gate.stages.some((stage) => stage.fromStation === station.id),
    )?.id ?? program.stations[0].id;

  const nextSteps =
    manifest.nextSteps.length > 0
      ? manifest.nextSteps
      : [
          `har line status ${manifest.id}`,
          `har line gate ${firstGatedStation} --line ${manifest.id}`,
          `Adapt the program: ${lineProgramPathRel(manifest.id)}`,
        ];

  const partial = {
    lineId: manifest.id,
    title: manifest.title ?? program.title,
    stageIds,
    filesWritten,
    warnings,
    nextSteps,
    programPath: lineProgramPathRel(manifest.id),
    docsPath: manifest.docsPath,
    source: meta.source,
    stationIds: program.stations.map((s) => s.id),
    firstGatedStationId: firstGatedStation,
  };

  const promptAbsPath = writeLineAdaptationPrompt(
    resolved,
    manifest.id,
    buildLineAdaptationPrompt(resolved, program, { ...partial, adaptPromptPath: '' }),
  );
  const adaptPromptPath = path.relative(resolved, promptAbsPath);
  stampManifestWriter(resolved);

  success(`Applied line: ${manifest.id}`);
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
  const source = resolveLineSource(spec, repoPath);
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
