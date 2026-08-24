import * as fs from 'fs';
import * as path from 'path';
import { listSlotRegistryEntries } from '../core/slot-registry';
import { EJECTED_RUNTIME_BUNDLE, EJECTED_RUNTIME_DIR } from './eject';
import { readValidatedHarnessEnv } from './env';
import { getHarnessDir, readManifest } from './manifest';
import { RUNTIME_SHIM_FILES } from './template-tokens';
import { HarnessStage, HarnessStageRegistry, PortLane } from './schema';
import { readStageRegistry } from './stages';
import { findPhantomVerificationStageIds } from './verification';
import { LIFECYCLE_HOOKS } from '../runtime/hooks';

/**
 * `har env doctor` — harness contract validation (#232).
 *
 * Validates the customization surface (harness.env, stages.json, stage
 * scripts, port lanes, slot registry) so a broken adaptation is caught with a
 * specific, actionable message before an agent hits it mid-session.
 */

export type DoctorCheckId =
  | 'harness-env'
  | 'stages-registry'
  | 'stage-files'
  | 'lifecycle-stages'
  | 'verification-ids'
  | 'port-lanes'
  | 'slot-registry'
  | 'hooks'
  | 'ejected-runtime';

export type DoctorContract = '1.0' | 'pre-1.0' | 'none';

export interface DoctorFinding {
  check: DoctorCheckId;
  severity: 'error' | 'warning';
  /** File the finding is about, relative to .har/ (or repo root when noted). */
  file?: string;
  /** 1-indexed line when the issue is tied to a line. */
  line?: number;
  message: string;
  /** What to do about it. */
  remedy?: string;
}

export interface DoctorCheck {
  id: DoctorCheckId;
  label: string;
  status: 'pass' | 'warn' | 'fail' | 'skip';
}

export interface DoctorReport {
  /** True when no error-severity findings exist (warnings allowed). */
  ok: boolean;
  /**
   * Which harness.env contract the harness follows. Pre-1.0 harnesses (shell
   * helper functions / port triplets still in harness.env) degrade contract
   * findings to warnings until they migrate (#241); 'none' means no
   * harness.env at all (init not finished).
   */
  contract: DoctorContract;
  checks: DoctorCheck[];
  findings: DoctorFinding[];
}

const CHECK_LABELS: Record<DoctorCheckId, string> = {
  'harness-env': 'harness.env schema',
  'stages-registry': 'stages.json registry',
  'stage-files': 'stage scripts & commands',
  'lifecycle-stages': 'lifecycle stages (launch/verify/teardown)',
  'verification-ids': 'verificationStages ids',
  'port-lanes': 'infra port lanes',
  'slot-registry': 'slot registry worktrees',
  hooks: 'lifecycle hooks (.har/hooks)',
  'ejected-runtime': 'ejected runtime (user-owned)',
};

/** Legacy helper functions whose presence marks a pre-1.0 harness.env. */
const PRE_1_0_FUNCTION_RE =
  /^\s*(har_infra_enabled|har_pg|har_node_[a-z_]+|har_pkg_exec)\s*\(\)/m;
const LEGACY_TRIPLET_RE = /^export\s+HARNESS_[A-Z0-9_]+_PORT_(DEFAULT|SCAN_START|SCAN_END)=/m;

function detectContract(harnessDir: string): DoctorContract {
  const envPath = path.join(harnessDir, 'harness.env');
  if (!fs.existsSync(envPath)) return 'none';
  const content = fs.readFileSync(envPath, 'utf8');
  if (PRE_1_0_FUNCTION_RE.test(content) || LEGACY_TRIPLET_RE.test(content)) {
    return 'pre-1.0';
  }
  return '1.0';
}

/**
 * Resolve the file a stage executes, when it names one. Command stages that
 * run arbitrary shell (e.g. `npm test`) resolve to null and are not
 * file-checked.
 */
function resolveStageFile(harnessDir: string, stage: HarnessStage): string | null {
  if (stage.script) return path.join(harnessDir, stage.script);
  if (stage.command) {
    const first = stage.command.trim().split(/\s+/)[0];
    if (first.startsWith('./.har/')) {
      return path.join(harnessDir, first.replace(/^\.\/\.har\//, ''));
    }
    if (first.startsWith('.har/')) {
      return path.join(harnessDir, first.replace(/^\.har\//, ''));
    }
    return null;
  }
  return path.join(harnessDir, 'stages', `${stage.id}.sh`);
}

function checkStatus(findings: DoctorFinding[], id: DoctorCheckId): DoctorCheck {
  const mine = findings.filter((f) => f.check === id);
  if (mine.some((f) => f.severity === 'error')) return { id, label: CHECK_LABELS[id], status: 'fail' };
  if (mine.length > 0) return { id, label: CHECK_LABELS[id], status: 'warn' };
  return { id, label: CHECK_LABELS[id], status: 'pass' };
}

export function runDoctor(repoPath: string): DoctorReport {
  const harnessDir = getHarnessDir(repoPath);
  const findings: DoctorFinding[] = [];
  const skipped = new Set<DoctorCheckId>();

  if (!fs.existsSync(harnessDir)) {
    return {
      ok: false,
      contract: 'none',
      checks: (Object.keys(CHECK_LABELS) as DoctorCheckId[]).map((id) => ({
        id,
        label: CHECK_LABELS[id],
        status: 'skip',
      })),
      findings: [
        {
          check: 'stages-registry',
          severity: 'error',
          file: '.har',
          message: 'Harness directory .har/ not found',
          remedy: 'Run `har env init` to scaffold the harness',
        },
      ],
    };
  }

  const contract = detectContract(harnessDir);
  // Pre-1.0 harnesses keep working until they migrate (#241): contract
  // findings degrade to warnings so maintain/launch report instead of block.
  const contractSeverity: 'error' | 'warning' = contract === '1.0' ? 'error' : 'warning';

  // 1. harness.env against HarnessEnvSchema
  const envValidation = readValidatedHarnessEnv(repoPath);
  let portLanes: Record<string, PortLane> = {};
  if (!envValidation) {
    findings.push({
      check: 'harness-env',
      severity: 'error',
      file: 'harness.env',
      message: 'harness.env not found',
      remedy: 'Run `har env maintain` to regenerate it from the template',
    });
  } else {
    portLanes = envValidation.portLanes;
    for (const issue of envValidation.issues) {
      findings.push({
        check: 'harness-env',
        severity: issue.severity === 'error' ? contractSeverity : 'warning',
        file: 'harness.env',
        line: issue.line,
        message: issue.message,
        remedy:
          contract === 'pre-1.0'
            ? 'Pre-1.0 harness — migration to the 1.0 pure-config contract lands with `har env migrate` (#241)'
            : undefined,
      });
    }
  }

  // 2. stages.json parses against the registry schema
  let registry: HarnessStageRegistry | null = null;
  try {
    const stagesPath = path.join(harnessDir, 'stages.json');
    if (fs.existsSync(stagesPath)) {
      // The registry schema is deliberately lenient (defaults + passthrough),
      // so a structurally gutted stages.json would otherwise parse as empty.
      const raw = JSON.parse(fs.readFileSync(stagesPath, 'utf8'));
      if (typeof raw !== 'object' || raw === null || !Array.isArray(raw.stages)) {
        throw new Error('stages.json has no `stages` array — the registry is structurally invalid');
      }
    }
    registry = readStageRegistry(repoPath);
    if (registry.stages.length === 0) {
      findings.push({
        check: 'stages-registry',
        severity: contractSeverity,
        file: 'stages.json',
        message: 'No stages registered',
        remedy: 'Run `har env maintain` to restore the default stages',
      });
    }
  } catch (err) {
    // Corrupt/unparseable stages.json breaks every surface — always an error.
    findings.push({
      check: 'stages-registry',
      severity: 'error',
      file: 'stages.json',
      message: err instanceof Error ? err.message : String(err),
      remedy: 'Fix .har/stages.json or restore it from git, then re-run `har env doctor`',
    });
    skipped.add('stage-files');
    skipped.add('lifecycle-stages');
    skipped.add('verification-ids');
  }

  if (registry) {
    // 3. Every registered stage's script/command file exists and is executable
    for (const stage of registry.stages) {
      const file = resolveStageFile(harnessDir, stage);
      if (!file) continue;
      const rel = path.relative(harnessDir, file);
      if (!fs.existsSync(file)) {
        findings.push({
          check: 'stage-files',
          severity: contractSeverity,
          file: rel,
          message: `Stage \`${stage.id}\` points at ${rel}, which does not exist`,
          remedy: `Restore .har/${rel} or remove/fix the \`${stage.id}\` entry in stages.json`,
        });
        continue;
      }
      if (rel.endsWith('.sh') && !(fs.statSync(file).mode & 0o111)) {
        findings.push({
          check: 'stage-files',
          severity: 'warning',
          file: rel,
          message: `Stage \`${stage.id}\` script ${rel} is not executable`,
          remedy: `chmod +x .har/${rel}`,
        });
      }
    }

    // 4. Required lifecycle stages resolve
    for (const kind of ['launch', 'verify', 'teardown'] as const) {
      const stage = registry.stages.find((s) => s.kind === kind);
      if (!stage) {
        findings.push({
          check: 'lifecycle-stages',
          severity: contractSeverity,
          file: 'stages.json',
          message: `No stage of kind \`${kind}\` is registered — \`har env ${kind}\` cannot run`,
          remedy: 'Run `har env maintain` to restore the default lifecycle stages',
        });
        continue;
      }
      const file = resolveStageFile(harnessDir, stage);
      if (file && !fs.existsSync(file)) {
        findings.push({
          check: 'lifecycle-stages',
          severity: contractSeverity,
          file: path.relative(harnessDir, file),
          message: `Lifecycle stage \`${stage.id}\` (${kind}) points at a missing file`,
          remedy: `Restore .har/${path.relative(harnessDir, file)} or fix the \`${stage.id}\` entry in stages.json`,
        });
      }
    }

    // 5. verificationStages is a fully resolvable namespace
    for (const id of findPhantomVerificationStageIds(registry)) {
      findings.push({
        check: 'verification-ids',
        severity: contractSeverity,
        file: 'stages.json',
        message: `verificationStages id \`${id}\` does not resolve to a registered runnable stage`,
        remedy: `Register a stage with id \`${id}\` (har env add-stage ${id} --custom) or remove it from verificationStages`,
      });
    }
  }

  // 6. Port lanes are coherent
  const laneEntries = Object.entries(portLanes);
  for (const [service, lane] of laneEntries) {
    if (lane.default < lane.scanStart || lane.default > lane.scanEnd) {
      findings.push({
        check: 'port-lanes',
        severity: 'warning',
        file: 'harness.env',
        message: `Port lane \`${service}\` default ${lane.default} is outside its scan range ${lane.scanStart}-${lane.scanEnd}`,
        remedy: 'Adjust HARNESS_INFRA_PORT_LANES so the default falls inside the scan range',
      });
    }
  }
  for (let i = 0; i < laneEntries.length; i++) {
    for (let j = i + 1; j < laneEntries.length; j++) {
      const [aName, a] = laneEntries[i];
      const [bName, b] = laneEntries[j];
      if (a.scanStart <= b.scanEnd && b.scanStart <= a.scanEnd) {
        findings.push({
          check: 'port-lanes',
          severity: contractSeverity,
          file: 'harness.env',
          message: `Port lanes \`${aName}\` (${a.scanStart}-${a.scanEnd}) and \`${bName}\` (${b.scanStart}-${b.scanEnd}) overlap — parallel slots would collide`,
          remedy: 'Give each service a disjoint scan range in HARNESS_INFRA_PORT_LANES',
        });
      }
    }
  }

  // 7. Ejected runtime (#239): the vendored runtime the user-owned scripts
  // execute must exist and the scripts must be executable. Not ejected → skip.
  const manifest = readManifest(repoPath);
  if (!manifest?.ejected) {
    skipped.add('ejected-runtime');
  } else {
    const runtimeRel = path.join(EJECTED_RUNTIME_DIR, EJECTED_RUNTIME_BUNDLE);
    const runtimePath = path.join(harnessDir, runtimeRel);
    if (!fs.existsSync(runtimePath)) {
      findings.push({
        check: 'ejected-runtime',
        severity: 'error',
        file: runtimeRel,
        message: `Harness is ejected but the vendored runtime .har/${runtimeRel} is missing`,
        remedy: 'Restore it from git, re-run `har env eject`, or return to managed shims with `har env adopt`',
      });
    }
    for (const shim of RUNTIME_SHIM_FILES) {
      const shimPath = path.join(harnessDir, shim);
      if (!fs.existsSync(shimPath)) continue; // missing lifecycle scripts are caught above
      if (!(fs.statSync(shimPath).mode & 0o111)) {
        findings.push({
          check: 'ejected-runtime',
          severity: 'warning',
          file: shim,
          message: `Ejected script ${shim} is not executable`,
          remedy: `chmod +x .har/${shim}`,
        });
      }
    }
  }

  // 8. Slot registry entries point at existing worktrees
  for (const entry of listSlotRegistryEntries(repoPath)) {
    if (entry.status === 'completed') continue;
    const dir = entry.worktreePath ?? entry.workDir;
    if (dir && !fs.existsSync(dir)) {
      findings.push({
        check: 'slot-registry',
        severity: 'warning',
        file: `slots/agent-${entry.agentId}.json`,
        message: `Slot ${entry.agentId} (${entry.status}) points at a missing worktree: ${dir}`,
        remedy: `Run \`har env teardown ${entry.agentId}\` (or \`har env cleanup\`) to clear the stale session`,
      });
    }
  }

  // 8. Lifecycle hooks (#238): user-owned scripts — validated for shape only
  // (recognized name, executable), never compared against templates.
  const hooksDir = path.join(harnessDir, 'hooks');
  if (fs.existsSync(hooksDir)) {
    for (const file of fs.readdirSync(hooksDir).sort()) {
      const full = path.join(hooksDir, file);
      if (!fs.statSync(full).isFile() || !file.endsWith('.sh')) continue;
      if (!(LIFECYCLE_HOOKS as readonly string[]).includes(file.replace(/\.sh$/, ''))) {
        findings.push({
          check: 'hooks',
          severity: 'warning',
          file: `hooks/${file}`,
          message: `hooks/${file} is not a recognized lifecycle hook (expected one of: ${LIFECYCLE_HOOKS.map((h) => `${h}.sh`).join(', ')})`,
          remedy: 'Rename it to a supported hook, or keep helper scripts outside .har/hooks/',
        });
        continue;
      }
      if (!(fs.statSync(full).mode & 0o111)) {
        findings.push({
          check: 'hooks',
          severity: 'warning',
          file: `hooks/${file}`,
          message: `Hook hooks/${file} is not executable`,
          remedy: `chmod +x .har/hooks/${file}`,
        });
      }
    }
  }

  const checks = (Object.keys(CHECK_LABELS) as DoctorCheckId[]).map((id) =>
    skipped.has(id) ? { id, label: CHECK_LABELS[id], status: 'skip' as const } : checkStatus(findings, id),
  );

  return {
    ok: !findings.some((f) => f.severity === 'error'),
    contract,
    checks,
    findings,
  };
}

const STATUS_SYMBOL: Record<DoctorCheck['status'], string> = {
  pass: '✓',
  warn: '⚠',
  fail: '✗',
  skip: '−',
};

/** Render a doctor report as a human-readable pass/fail summary. */
export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  for (const check of report.checks) {
    lines.push(`${STATUS_SYMBOL[check.status]} ${check.label}`);
    for (const finding of report.findings.filter((f) => f.check === check.id)) {
      const where = finding.file
        ? ` [${finding.file}${finding.line !== undefined ? `:${finding.line}` : ''}]`
        : '';
      lines.push(`    ${finding.severity === 'error' ? 'ERROR' : 'warn '}${where} ${finding.message}`);
      if (finding.remedy) lines.push(`      → ${finding.remedy}`);
    }
  }
  if (report.contract !== '1.0') {
    lines.push(
      report.contract === 'pre-1.0'
        ? 'Contract: pre-1.0 harness — contract findings reported as warnings until migration (#241).'
        : 'Contract: no harness.env found.',
    );
  }
  lines.push(report.ok ? 'Doctor: PASS' : 'Doctor: FAIL');
  return lines.join('\n');
}

/**
 * One-line doctor summary for auto-runs inside maintain/launch; null when
 * there is nothing worth reporting.
 */
export function summarizeDoctorReport(report: DoctorReport): string | null {
  const errors = report.findings.filter((f) => f.severity === 'error').length;
  const warnings = report.findings.filter((f) => f.severity === 'warning').length;
  if (errors === 0 && warnings === 0) return null;
  const parts: string[] = [];
  if (errors) parts.push(`${errors} error${errors === 1 ? '' : 's'}`);
  if (warnings) parts.push(`${warnings} warning${warnings === 1 ? '' : 's'}`);
  return `doctor: ${parts.join(', ')} — run \`har env doctor\` for the full report`;
}
