import * as fs from 'fs';
import * as path from 'path';
import { run } from '../utils/shell';
import { parseHarnessEnvContent } from './env';
import { getHarnessDir, readManifest } from './manifest';
import { readStageRegistry } from './stages';
import { resolveTemplatesDir } from '../utils/paths';

export interface ValidationIssue {
  file: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface ValidationResult {
  pass: boolean;
  issues: ValidationIssue[];
}

const REQUIRED_FILES_DEFAULT = [
  'README.md',
  'stages.json',
  'harness.env',
  'setup-infra.sh',
  'launch.sh',
  'provision-toolchain.sh',
  'verify.sh',
  'teardown.sh',
  'agent-cli.sh',
  'agent-slot.sh',
  'docker-compose.agent.yml',
  'env.template',
  'ecosystem.agent.template.cjs',
  'CLAUDE.agent.md',
];

const REQUIRED_FILES_CLI = REQUIRED_FILES_DEFAULT.filter(
  (file) => file !== 'ecosystem.agent.template.cjs' && file !== 'env.template',
);

const REQUIRED_FILES_IOS = [
  'README.md',
  'stages.json',
  'harness.env',
  'setup-infra.sh',
  'launch.sh',
  'provision-toolchain.sh',
  'verify.sh',
  'teardown.sh',
  'agent-cli.sh',
  'agent-slot.sh',
  'docker-compose.agent.yml',
  'CLAUDE.agent.md',
];

function getRequiredFiles(repoPath: string): string[] {
  const manifest = readManifest(repoPath);
  if (manifest?.profile === 'cli') return REQUIRED_FILES_CLI;
  if (manifest?.profile === 'ios') return REQUIRED_FILES_IOS;
  return REQUIRED_FILES_DEFAULT;
}

const SHELL_SCRIPTS = [
  'setup-infra.sh',
  'launch.sh',
  'provision-toolchain.sh',
  'verify.sh',
  'teardown.sh',
  'agent-cli.sh',
  'attach.sh',
];

/** Keys whose scaffold placeholder means the harness was never adapted. */
const IOS_PLACEHOLDER_KEYS = ['HARNESS_XCODE_SCHEME', 'HARNESS_BUNDLE_ID'] as const;

/**
 * The placeholder values the iOS scaffold actually ships, read from the template
 * rather than restated here — otherwise changing the template silently disables
 * this check.
 */
function iosPlaceholders(): Record<string, string> {
  const templateEnv = path.join(resolveTemplatesDir(), 'har-boilerplate-ios', 'harness.env');
  if (!fs.existsSync(templateEnv)) return {};
  const template = parseHarnessEnvContent(fs.readFileSync(templateEnv, 'utf8'));

  const placeholders: Record<string, string> = {};
  for (const key of IOS_PLACEHOLDER_KEYS) {
    if (template[key]) placeholders[key] = template[key];
  }
  return placeholders;
}

/**
 * Filesystem-only checks on the iOS harness config.
 *
 * Deliberately does not shell out to `xcodebuild` to confirm the scheme still
 * exists in the project: validation runs on every init and maintain, and must stay
 * fast and work on machines without Xcode. What is checked here — placeholders left
 * in place, and a project path that no longer resolves — covers the cases that
 * actually break a build, at no cost.
 *
 * Takes the already-read harness.env content: the caller has it in hand, and
 * validation runs on every init and maintain.
 */
function validateIosHarnessEnv(repoPath: string, harnessEnvContent: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const env = parseHarnessEnvContent(harnessEnvContent);

  for (const [key, placeholder] of Object.entries(iosPlaceholders())) {
    if (env[key] === placeholder) {
      issues.push({
        file: 'harness.env',
        message: `${key} is still the scaffold placeholder "${placeholder}" — the build will not find it`,
        severity: 'warning',
      });
    }
  }

  for (const key of ['HARNESS_XCODE_WORKSPACE', 'HARNESS_XCODE_PROJECT']) {
    const configured = env[key];
    if (!configured) continue;
    if (!fs.existsSync(path.join(repoPath, configured))) {
      issues.push({
        file: 'harness.env',
        message: `${key} points at "${configured}", which does not exist — it was renamed, moved, or is generated at launch`,
        severity: 'warning',
      });
    }
  }

  return issues;
}

export function validateHarness(repoPath: string): ValidationResult {
  const harnessDir = getHarnessDir(repoPath);
  const issues: ValidationIssue[] = [];

  if (!fs.existsSync(harnessDir)) {
    return {
      pass: false,
      issues: [{ file: '.har', message: 'Harness directory not found', severity: 'error' }],
    };
  }

  for (const file of getRequiredFiles(repoPath)) {
    const filePath = path.join(harnessDir, file);
    if (!fs.existsSync(filePath)) {
      issues.push({ file, message: 'Required file missing', severity: 'error' });
    }
  }

  for (const script of SHELL_SCRIPTS) {
    const scriptPath = path.join(harnessDir, script);
    if (!fs.existsSync(scriptPath)) continue;

    const stat = fs.statSync(scriptPath);
    if (!(stat.mode & 0o111)) {
      issues.push({ file: script, message: 'Script is not executable', severity: 'warning' });
    }

    const result = run(`bash -n "${scriptPath}"`);
    if (result.code !== 0) {
      issues.push({
        file: script,
        message: `Syntax error: ${result.stderr.trim()}`,
        severity: 'error',
      });
    }
  }

  const manifest = readManifest(repoPath);
  const profile = manifest?.profile ?? 'default';

  const ecosystemPath = path.join(harnessDir, 'ecosystem.agent.template.cjs');
  if (profile !== 'cli' && fs.existsSync(ecosystemPath)) {
    const content = fs.readFileSync(ecosystemPath, 'utf8');
    if (!content.includes('module.exports')) {
      issues.push({
        file: 'ecosystem.agent.template.cjs',
        message: 'Missing module.exports',
        severity: 'error',
      });
    }
  }

  const harnessEnvPath = path.join(harnessDir, 'harness.env');
  if (fs.existsSync(harnessEnvPath)) {
    const content = fs.readFileSync(harnessEnvPath, 'utf8');
    if (content.includes('TODO: set migrate command')) {
      issues.push({ file: 'harness.env', message: 'Migrate command still has TODO', severity: 'warning' });
    }
    if (content.includes('TODO: set seed command')) {
      issues.push({ file: 'harness.env', message: 'Seed command still has TODO', severity: 'warning' });
    }
    if (profile === 'ios') {
      issues.push(...validateIosHarnessEnv(repoPath, content));
    }
  }

  const verifyPath = path.join(harnessDir, 'verify.sh');
  if (fs.existsSync(verifyPath)) {
    const content = fs.readFileSync(verifyPath, 'utf8');
    if (content.includes("echo 'TODO:")) {
      issues.push({ file: 'verify.sh', message: 'Verification steps still have TODO placeholders', severity: 'warning' });
    }
  }

  const stagesPath = path.join(harnessDir, 'stages.json');
  if (fs.existsSync(stagesPath)) {
    try {
      JSON.parse(fs.readFileSync(stagesPath, 'utf8'));
      const registry = readStageRegistry(repoPath);
      if (registry.stages.length === 0) {
        issues.push({ file: 'stages.json', message: 'No harness stages declared', severity: 'warning' });
      }
    } catch (err) {
      issues.push({
        file: 'stages.json',
        message: err instanceof Error ? err.message : 'Invalid stages.json',
        severity: 'error',
      });
    }
  } else {
    issues.push({ file: 'stages.json', message: 'Stage registry missing', severity: 'warning' });
  }

  const readmePath = path.join(harnessDir, 'README.md');
  if (fs.existsSync(readmePath)) {
    const content = fs.readFileSync(readmePath, 'utf8');
    if (!content.includes('.har')) {
      issues.push({ file: 'README.md', message: 'README should document .har/ paths', severity: 'warning' });
    }
    if (content.length < 200) {
      issues.push({ file: 'README.md', message: 'README is too short — should explain harness contents', severity: 'warning' });
    }
  }

  const errors = issues.filter((i) => i.severity === 'error');
  return { pass: errors.length === 0, issues };
}

export async function smokeTestHarness(repoPath: string): Promise<ValidationResult> {
  const harnessDir = getHarnessDir(repoPath);
  const issues: ValidationIssue[] = [];

  const setupScript = path.join(harnessDir, 'setup-infra.sh');
  if (fs.existsSync(setupScript)) {
    const result = run(`bash "${setupScript}"`, { cwd: repoPath });
    if (result.code !== 0) {
      issues.push({
        file: 'setup-infra.sh',
        message: `Smoke test failed: ${result.stderr.slice(0, 200)}`,
        severity: 'error',
      });
    }
  }

  const errors = issues.filter((i) => i.severity === 'error');
  return { pass: errors.length === 0, issues };
}
