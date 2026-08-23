import * as fs from 'fs';
import * as path from 'path';
import { run } from '../utils/shell';
import { readValidatedHarnessEnv } from './env';
import { getHarnessDir, readManifest } from './manifest';
import { readStageRegistry } from './stages';
import { findPhantomVerificationStageIds } from './verification';

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
    // Schema-validate against the 1.0 pure-config contract. Reported as
    // warnings here so pre-1.0 harnesses keep validating until they migrate;
    // `har env doctor` (#232) enforces these as errors.
    const envValidation = readValidatedHarnessEnv(repoPath);
    for (const issue of envValidation?.issues ?? []) {
      issues.push({
        file: 'harness.env',
        message: issue.line !== undefined ? `line ${issue.line}: ${issue.message}` : issue.message,
        severity: 'warning',
      });
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
      for (const id of findPhantomVerificationStageIds(registry)) {
        // Warning until har env doctor (#232) enforces the resolvable-namespace
        // contract as an error.
        issues.push({
          file: 'stages.json',
          message: `verificationStages id "${id}" does not resolve to a registered runnable stage`,
          severity: 'warning',
        });
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
