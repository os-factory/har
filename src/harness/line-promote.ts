import * as fs from 'fs';
import * as path from 'path';
import { findManifestPath } from './bundle-resolve';
import { PERSONAL_LINE_README_NOTE } from './line-create';
import { readLineLedger, removeLineLedgerEntry, upsertLineLedgerEntry, getLineLedgerPath } from './line-ledger';
import { LINE_BUNDLE_CONFIG } from './line-resolve';
import {
  isHarLocalPath,
  isUnderHarDir,
  personalFileDest,
  resolveHarPath,
  resolveRepoFilePath,
  scopeRoot,
} from './line-scope';
import { lineDirRel, lineProgramPathRel, locateInstalledLine, readLineManifestFromDir } from './lines';
import { DEFAULT_HAR_DIR, getManifestPath, stampManifestWriter } from './manifest';
import { harnessExists } from './parser';
import type { HarnessStage } from './schema';
import {
  getStageOverlayPath,
  getStageRegistryPath,
  readCommittedStageRegistry,
  readStageOverlay,
  writeStageOverlay,
  writeStageRegistry,
} from './stages';

export interface PromoteLineResult {
  lineId: string;
  /** Team home the line now lives in, e.g. `.har/lines/<id>`. */
  lineDirRel: string;
  programPath: string;
  /** Stage ids moved from the personal overlay into `.har/stages.json`. */
  stageIds: string[];
  /** Repo-relative files the promote created or changed — the diff to commit. */
  filesToCommit: string[];
  warnings: string[];
  nextSteps: string[];
}

/** `.har/local/x` → `.har/x` (repo-relative). */
function teamFileDest(dest: string): string {
  const normalized = dest.replace(/\\/g, '/').replace(/^\.\//, '');
  return normalized.replace(new RegExp(`^${DEFAULT_HAR_DIR}/local/`), `${DEFAULT_HAR_DIR}/`);
}

/** `local/stages/x.sh` → `stages/x.sh` (`.har/`-relative). */
function teamHarPath(harRel: string): string {
  return harRel.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^local\//, '');
}

function sameContent(a: string, b: string): boolean {
  return fs.readFileSync(a).equals(fs.readFileSync(b));
}

/** Snapshot of a file's bytes (null = it did not exist) so a failed promote can put it back. */
interface FileSnapshot {
  file: string;
  bytes: Buffer | null;
}

function snapshot(file: string): FileSnapshot {
  return { file, bytes: fs.existsSync(file) ? fs.readFileSync(file) : null };
}

function restore(snap: FileSnapshot): void {
  if (snap.bytes === null) {
    fs.rmSync(snap.file, { force: true });
  } else {
    fs.mkdirSync(path.dirname(snap.file), { recursive: true });
    fs.writeFileSync(snap.file, snap.bytes);
  }
}

/**
 * Move a personal line to team scope: its program and manifest, the stage
 * scripts it installed, its stages (overlay → `.har/stages.json`) and its ledger
 * entry (`.har/local/lines.json` → `.har/lines.json`). The result is an ordinary
 * diff to commit. `verificationStages` is never touched.
 *
 * One way only: there is deliberately no demote — a committed team line may be
 * required by others, so taking it private is not a local decision.
 *
 * Everything is checked before anything is written, then the team copy is
 * written before the personal one is removed; if a write fails, every file is
 * put back, so a line never ends up in both scopes or in neither.
 */
export function promoteLine(repoPath: string, lineId: string): PromoteLineResult {
  const repo = path.resolve(repoPath);
  if (!harnessExists(repo)) {
    throw new Error('No .har/ harness found. Run "har onboard" first.');
  }

  const scope = locateInstalledLine(repo, lineId);
  if (scope === null) {
    throw new Error(`Line not installed: ${lineId}. Personal lines are listed by: har line list`);
  }
  if (scope === 'team') {
    throw new Error(`Line "${lineId}" is already a team line (${lineDirRel(lineId, 'team')}).`);
  }

  const personalRoot = scopeRoot(repo, 'personal');
  const personalDir = path.join(personalRoot, lineDirRel(lineId, 'personal'));
  const teamDirRel = lineDirRel(lineId, 'team');
  const teamDir = path.join(repo, teamDirRel);
  if (fs.existsSync(teamDir)) {
    throw new Error(`${teamDirRel}/ already exists. Remove it first, then promote again.`);
  }

  const ledgerEntry = readLineLedger(repo, 'personal')?.lines.find((l) => l.id === lineId);
  const warnings: string[] = [];

  // Files the personal install copied under .har/local/ (from the bundle manifest),
  // keyed by their team destination.
  const moves = new Map<string, string>(); // team repo-relative → personal absolute
  const manifestPath = findManifestPath(personalDir, LINE_BUNDLE_CONFIG);
  if (ledgerEntry && manifestPath) {
    const manifest = readLineManifestFromDir(personalDir, lineId);
    for (const file of manifest.files) {
      if (!isUnderHarDir(file.dest)) continue; // already in the shared tree
      const source = resolveRepoFilePath(repo, personalFileDest(file.dest));
      if (!fs.existsSync(source)) {
        warnings.push(`${personalFileDest(file.dest)} is missing — not copied to ${teamFileDest(file.dest)}.`);
        continue;
      }
      moves.set(teamFileDest(file.dest), source);
    }
  }

  // Stages: the line's entries in the personal overlay, with scripts pointed at the team copy.
  const overlay = readStageOverlay(repo);
  const lineStageIds = new Set(ledgerEntry?.stageIds ?? []);
  const movedStages: HarnessStage[] = (overlay?.stages ?? [])
    .filter((stage) => lineStageIds.has(stage.id))
    .map((stage) => {
      if (!stage.script || !isHarLocalPath(stage.script)) return stage;
      const teamScript = teamHarPath(stage.script);
      const teamRel = `${DEFAULT_HAR_DIR}/${teamScript}`;
      if (!moves.has(teamRel)) {
        const source = resolveHarPath(repo, stage.script);
        if (fs.existsSync(source)) moves.set(teamRel, source);
      }
      return { ...stage, script: teamScript };
    });

  const committed = readCommittedStageRegistry(repo);
  const taken = movedStages.filter((stage) => committed.stages.some((s) => s.id === stage.id));
  if (taken.length > 0) {
    throw new Error(
      `Stage id(s) ${taken.map((s) => s.id).join(', ')} already exist in .har/stages.json. ` +
        'Rename or remove the committed one, then promote again.',
    );
  }
  const clobbered = [...moves].filter(
    ([teamRel, source]) => fs.existsSync(path.join(repo, teamRel)) && !sameContent(path.join(repo, teamRel), source),
  );
  if (clobbered.length > 0) {
    throw new Error(
      `Promoting would overwrite committed file(s): ${clobbered.map(([rel]) => rel).join(', ')}. ` +
        'Move them aside, then promote again.',
    );
  }

  // Every file this may write, so a failure can put all of them back.
  const snapshots = [
    getStageRegistryPath(repo),
    getStageOverlayPath(repo),
    getLineLedgerPath(repo, 'team'),
    getLineLedgerPath(repo, 'personal'),
    getManifestPath(repo),
    ...[...moves.keys()].map((rel) => path.join(repo, rel)),
  ].map(snapshot);
  const verificationBefore = JSON.stringify(committed.verificationStages ?? null);
  const programPath = lineProgramPathRel(lineId, 'team');

  try {
    // 1. Team copy: line home, then the files it installed.
    fs.cpSync(personalDir, teamDir, { recursive: true });
    const readme = path.join(teamDir, 'README.md');
    if (fs.existsSync(readme)) {
      fs.writeFileSync(
        readme,
        fs.readFileSync(readme, 'utf8').replace(PERSONAL_LINE_README_NOTE, '').replace(/ --personal\b/g, ''),
      );
    }
    for (const [teamRel, source] of moves) {
      const dest = path.join(repo, teamRel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(source, dest);
      fs.chmodSync(dest, fs.statSync(source).mode);
    }

    // 2. Stages: out of the overlay first (the committed writer refuses overlay ids).
    if (overlay && movedStages.length > 0) {
      const movedIds = new Set(movedStages.map((s) => s.id));
      writeStageOverlay(repo, { ...overlay, stages: overlay.stages.filter((s) => !movedIds.has(s.id)) });
      writeStageRegistry(repo, { ...committed, stages: [...committed.stages, ...movedStages] });
    }
    if (JSON.stringify(readCommittedStageRegistry(repo).verificationStages ?? null) !== verificationBefore) {
      throw new Error('Promote changed verificationStages — this is a bug. Line stages must stay off verify.');
    }

    // 3. Ledgers: into the team one, then out of the personal one.
    if (ledgerEntry) {
      upsertLineLedgerEntry(repo, { ...ledgerEntry, programPath }, 'team');
      removeLineLedgerEntry(repo, lineId, 'personal');
    }
    stampManifestWriter(repo);
  } catch (err) {
    fs.rmSync(teamDir, { recursive: true, force: true });
    for (const snap of snapshots) restore(snap);
    throw new Error(`Promote failed and was rolled back: ${(err as Error).message}`);
  }

  // 4. The team copy is complete — drop the personal one.
  fs.rmSync(personalDir, { recursive: true, force: true });
  for (const source of moves.values()) {
    if (source.startsWith(path.join(personalRoot, DEFAULT_HAR_DIR, 'local') + path.sep)) {
      fs.rmSync(source, { force: true });
    }
  }

  const filesToCommit = [
    `${teamDirRel}/`,
    ...[...moves.keys()],
    ...(movedStages.length > 0 ? [`${DEFAULT_HAR_DIR}/stages.json`] : []),
    ...(ledgerEntry ? [`${DEFAULT_HAR_DIR}/lines.json`] : []),
    `${DEFAULT_HAR_DIR}/manifest.json`,
  ];

  return {
    lineId,
    lineDirRel: teamDirRel,
    programPath,
    stageIds: movedStages.map((s) => s.id),
    filesToCommit,
    warnings,
    nextSteps: [
      `git add ${filesToCommit.join(' ')}`,
      `git commit -m "chore(lines): share the ${lineId} line with the team"`,
      `har line gate <station> --line ${lineId}   # teammates and CI now see it`,
    ],
  };
}
