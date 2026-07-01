import * as fs from 'fs';
import * as path from 'path';

export function isPathUnderRoot(filePath: string, repoRoot: string): boolean {
  const resolved = path.resolve(filePath);
  const root = path.resolve(repoRoot);
  return resolved === root || resolved.startsWith(root + path.sep);
}

export interface ArtifactFile {
  absolutePath: string;
  relativePath: string;
  sizeBytes: number;
  modifiedAt: string;
}

export function listArtifactFiles(repoPath: string, artifactsSubdir = '.har/artifacts'): ArtifactFile[] {
  const artifactsDir = path.join(repoPath, artifactsSubdir);
  if (!fs.existsSync(artifactsDir)) return [];

  const files: ArtifactFile[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (!isPathUnderRoot(full, artifactsDir)) continue;
      if (entry.isDirectory()) walk(full);
      else {
        files.push({
          absolutePath: full,
          relativePath: path.relative(repoPath, full),
          sizeBytes: fs.statSync(full).size,
          modifiedAt: fs.statSync(full).mtime.toISOString(),
        });
      }
    }
  };
  walk(artifactsDir);
  return files;
}

export function readArtifactFile(repoPath: string, relativePath: string): Buffer | null {
  const full = path.resolve(repoPath, relativePath);
  const artifactsRoot = path.resolve(repoPath, '.har/artifacts');
  if (!isPathUnderRoot(full, artifactsRoot) || !fs.existsSync(full)) return null;
  return fs.readFileSync(full);
}
