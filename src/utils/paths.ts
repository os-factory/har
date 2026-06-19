import * as fs from 'fs';
import * as path from 'path';

/** Resolve templates dir for both bundled (dist/) and tsx (src/) runs. */
export function resolveTemplatesDir(): string {
  const candidates = [
    path.join(__dirname, 'templates'),
    path.join(__dirname, '..', 'templates'),
    path.join(__dirname, '..', 'harness', 'templates'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'har-boilerplate'))) return dir;
  }
  throw new Error('Templates directory not found. Run npm run build.');
}

export function resolvePromptPath(name: string): string {
  const candidates = [
    path.join(__dirname, 'prompts', name),
    path.join(__dirname, '..', 'llm', 'prompts', name),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return candidates[0];
}

export function resolveTemplateFile(name: string): string | null {
  const dir = resolveTemplatesDir();
  const filePath = path.join(dir, name);
  return fs.existsSync(filePath) ? filePath : null;
}
