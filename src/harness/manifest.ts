import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { HarnessManifest, HarnessManifestSchema } from './schema';
import { writeFileSafe } from '../utils/file-ops';

const GENERATOR_VERSION = '0.5.0';
const MANIFEST_VERSION = '1';
export const DEFAULT_HAR_DIR = '.har';

const CHECKSUM_SKIP = new Set([
  'manifest.json',
  'plugins.json',
  'AGENTS.md.proposed',
  'AGENTS.md.proposed.meta.json',
  'AGENT.md.proposed',
  'AGENT.md.proposed.meta.json',
  'ADAPT-PROMPT.md',
]);

export function getHarnessDir(repoPath: string): string {
  return path.join(repoPath, DEFAULT_HAR_DIR);
}

export function getManifestPath(repoPath: string): string {
  return path.join(getHarnessDir(repoPath), 'manifest.json');
}

export function readManifest(repoPath: string): HarnessManifest | null {
  const manifestPath = getManifestPath(repoPath);
  if (!fs.existsSync(manifestPath)) return null;
  const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const result = HarnessManifestSchema.safeParse(raw);
  return result.success ? result.data : null;
}

export function writeManifest(repoPath: string, manifest: HarnessManifest): void {
  const manifestPath = getManifestPath(repoPath);
  writeFileSafe(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}

export function computeFileChecksum(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

export function computeHarnessChecksums(harnessDir: string): Record<string, string> {
  const checksums: Record<string, string> = {};
  if (!fs.existsSync(harnessDir)) return checksums;

  for (const entry of fs.readdirSync(harnessDir, { withFileTypes: true })) {
    if (!entry.isFile() || CHECKSUM_SKIP.has(entry.name)) continue;
    const full = path.join(harnessDir, entry.name);
    checksums[entry.name] = computeFileChecksum(fs.readFileSync(full, 'utf8'));
  }
  return checksums;
}

export function createManifest(
  repoPath: string,
  adaptationSummary?: string,
  stack?: HarnessManifest['stack'],
  profile?: HarnessManifest['profile'],
): HarnessManifest {
  const now = new Date().toISOString();
  const harnessDir = getHarnessDir(repoPath);
  return {
    version: MANIFEST_VERSION,
    generatorVersion: GENERATOR_VERSION,
    outputDir: DEFAULT_HAR_DIR,
    createdAt: now,
    updatedAt: now,
    stack,
    adaptationSummary,
    profile,
    fileChecksums: computeHarnessChecksums(harnessDir),
  };
}

export function updateManifest(
  existing: HarnessManifest,
  updates: Partial<Pick<HarnessManifest, 'adaptationSummary' | 'stack' | 'fileChecksums'>>,
): HarnessManifest {
  return {
    ...existing,
    ...updates,
    updatedAt: new Date().toISOString(),
  };
}

export function resolveHarnessRoot(inputPath: string): string {
  let current = path.resolve(inputPath);
  const { root } = path.parse(current);

  for (;;) {
    const manifestPath = path.join(current, DEFAULT_HAR_DIR, 'manifest.json');
    if (fs.existsSync(manifestPath)) {
      return current;
    }
    if (current === root) break;
    current = path.dirname(current);
  }

  return path.resolve(inputPath);
}

export { GENERATOR_VERSION };
