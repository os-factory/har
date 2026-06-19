import * as fs from 'fs';
import * as path from 'path';

export function readFile(filePath: string, maxChars = 8000): string {
  if (!fs.existsSync(filePath)) return `[file not found: ${filePath}]`;
  if (fs.statSync(filePath).isDirectory()) {
    return `[path is a directory, not a file: ${filePath}. Use listDir instead.]`;
  }
  const content = fs.readFileSync(filePath, 'utf8');
  if (content.length > maxChars) {
    return content.slice(0, maxChars) + `\n... [truncated at ${maxChars} chars]`;
  }
  return content;
}

export function listDir(dirPath: string, maxFiles = 60): string[] {
  if (!fs.existsSync(dirPath)) return [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries.slice(0, maxFiles)) {
    const name = entry.isDirectory() ? entry.name + '/' : entry.name;
    result.push(name);
  }
  return result;
}

export function writeFileSafe(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

export function copyFileExecutable(src: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  fs.chmodSync(dest, 0o755);
}

export function fileExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

export function copyDirRecursive(srcDir: string, destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.copyFileSync(srcPath, destPath);
      if (entry.name.endsWith('.sh')) {
        fs.chmodSync(destPath, 0o755);
      }
    }
  }
}

export function resolveSafePath(baseDir: string, relativePath: string): string {
  const normalized = path.normalize(relativePath).replace(/^(\.\.(\/|\\|$))+/, '');
  const resolved = path.resolve(baseDir, normalized);
  const base = path.resolve(baseDir);
  if (!resolved.startsWith(base + path.sep) && resolved !== base) {
    throw new Error(`Path escapes harness directory: ${relativePath}`);
  }
  return resolved;
}
