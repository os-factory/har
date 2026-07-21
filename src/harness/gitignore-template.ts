import * as fs from 'fs';
import * as path from 'path';

/** Shipped in npm tarballs — npm always strips files named `.gitignore`. */
export const HARNESS_GITIGNORE_TEMPLATE = 'gitignore.template';
export const HARNESS_GITIGNORE_FILE = '.gitignore';

export function harnessFileForTemplate(templateFile: string): string {
  return templateFile === HARNESS_GITIGNORE_TEMPLATE ? HARNESS_GITIGNORE_FILE : templateFile;
}

export function templateFileForHarness(harnessFile: string): string {
  return harnessFile === HARNESS_GITIGNORE_FILE ? HARNESS_GITIGNORE_TEMPLATE : harnessFile;
}

function resolveGitignoreTemplateSource(boilerplateDir: string): string | null {
  const primary = path.join(boilerplateDir, HARNESS_GITIGNORE_TEMPLATE);
  if (fs.existsSync(primary)) return primary;
  const legacy = path.join(boilerplateDir, HARNESS_GITIGNORE_FILE);
  if (fs.existsSync(legacy)) return legacy;
  return null;
}

/** Write `.har/.gitignore` from the bundled boilerplate (npm-safe template name). */
export function writeHarnessGitignore(harnessDir: string, boilerplateDir: string): void {
  const src = resolveGitignoreTemplateSource(boilerplateDir);
  if (!src) return;
  fs.writeFileSync(path.join(harnessDir, HARNESS_GITIGNORE_FILE), fs.readFileSync(src, 'utf8'));
}

export function isExpectedHarnessOnlyFile(harnessFile: string, templateFiles: string[]): boolean {
  return harnessFile === HARNESS_GITIGNORE_FILE && templateFiles.includes(HARNESS_GITIGNORE_TEMPLATE);
}
