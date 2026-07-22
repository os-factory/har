import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getControlApiUrl } from './control-config';
import { getTelemetrySignals, isTelemetryEnabled } from './telemetry-config';

/** Pinned PyPI release for reproducible installs. */
export const OTEL_HOOKS_PACKAGE = 'opentelemetry-hooks==0.14.0';

export const OTEL_HOOKS_AGENTS = ['cursor', 'claude', 'codex'] as const;
export type OtelHooksAgent = (typeof OTEL_HOOKS_AGENTS)[number];

export interface OtelHooksConfig {
  OTEL_EXPORTER_OTLP_ENDPOINT: string | null;
  OTEL_EXPORTER_OTLP_PROTOCOL: string;
  OTEL_SERVICE_NAME: string;
  IDE_OTEL_BATCH_ON_STOP: string;
  IDE_OTEL_ENABLE_LOGS: string;
  IDE_OTEL_LOG_ALL_EVENTS: string;
  IDE_OTEL_CAPTURE_TEXT: string;
  IDE_OTEL_MASK_PROMPTS: string;
  OTEL_RESOURCE_ATTRIBUTES?: string | null;
}

export interface EnsureOtelHooksResult {
  ok: boolean;
  hooksHome: string;
  configPath: string;
  wrapperPath: string;
  otelHookCommand: string | null;
  message?: string;
  warning?: string;
  agentsSetup: OtelHooksAgent[];
  errors: string[];
}

export function getOtelHooksHome(): string {
  if (process.env.HAR_OTEL_HOOKS_HOME) {
    return path.resolve(process.env.HAR_OTEL_HOOKS_HOME);
  }
  return path.join(os.homedir(), '.har', 'otel-hooks');
}

export function getOtelHooksConfigPath(hooksHome = getOtelHooksHome()): string {
  return path.join(hooksHome, 'otel_config.json');
}

export function getOtelHooksWrapperPath(hooksHome = getOtelHooksHome()): string {
  return path.join(hooksHome, 'run-otel-hook.sh');
}

/** Build HAR-managed otel-hook config from current telemetry signals. */
export function buildOtelHooksConfig(options?: {
  enabled?: boolean;
  apiUrl?: string;
  resourceAttributes?: string;
}): OtelHooksConfig {
  const enabled = options?.enabled ?? isTelemetryEnabled();
  const signals = getTelemetrySignals();
  const apiUrl = (options?.apiUrl ?? getControlApiUrl()).replace(/\/$/, '');

  return {
    OTEL_EXPORTER_OTLP_ENDPOINT: enabled ? `${apiUrl}/api/otel/v1/traces` : null,
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    OTEL_SERVICE_NAME: 'har-ide-agent',
    IDE_OTEL_BATCH_ON_STOP: 'true',
    IDE_OTEL_ENABLE_LOGS: enabled && signals.logs ? 'true' : 'false',
    IDE_OTEL_LOG_ALL_EVENTS: enabled && signals.logs ? 'true' : 'false',
    IDE_OTEL_CAPTURE_TEXT: enabled && signals.prompts ? 'true' : 'false',
    IDE_OTEL_MASK_PROMPTS: 'false',
    OTEL_RESOURCE_ATTRIBUTES: options?.resourceAttributes ?? null,
  };
}

export function writeOtelHooksConfig(
  config: OtelHooksConfig,
  hooksHome = getOtelHooksHome(),
): string {
  fs.mkdirSync(hooksHome, { recursive: true });
  const configPath = getOtelHooksConfigPath(hooksHome);
  const payload = {
    _comment: 'Managed by har telemetry — do not edit by hand; use: har telemetry on|off',
    ...config,
  };
  fs.writeFileSync(configPath, `${JSON.stringify(payload, null, 2)}\n`);
  return configPath;
}

export function writeOtelHooksWrapper(
  otelHookCommand: string,
  hooksHome = getOtelHooksHome(),
): string {
  fs.mkdirSync(hooksHome, { recursive: true });
  const wrapperPath = getOtelHooksWrapperPath(hooksHome);
  const script = `#!/usr/bin/env bash
# Managed by har telemetry — invokes opentelemetry-hooks with HAR config home.
set -euo pipefail
export IDE_OTEL_HOOK_HOME="${hooksHome}"
exec "${otelHookCommand}" "$@"
`;
  fs.writeFileSync(wrapperPath, script, { mode: 0o755 });
  try {
    fs.chmodSync(wrapperPath, 0o755);
  } catch {
    // best-effort on platforms without chmod
  }
  return wrapperPath;
}

function commandExists(command: string): boolean {
  const result = spawnSync('sh', ['-c', `command -v ${JSON.stringify(command)}`], {
    encoding: 'utf8',
  });
  return result.status === 0 && Boolean(result.stdout?.trim());
}

function resolveOtelHookCommand(): string | null {
  if (commandExists('otel-hook')) {
    const which = spawnSync('sh', ['-c', 'command -v otel-hook'], { encoding: 'utf8' });
    return which.stdout?.trim() || 'otel-hook';
  }
  return null;
}

function tryInstallPackage(): { ok: boolean; detail: string } {
  if (commandExists('uv')) {
    const result = spawnSync(
      'uv',
      ['tool', 'install', '--force', OTEL_HOOKS_PACKAGE],
      { encoding: 'utf8', timeout: 180_000 },
    );
    if (result.status === 0) {
      return { ok: true, detail: `uv tool install ${OTEL_HOOKS_PACKAGE}` };
    }
  }

  if (commandExists('pipx')) {
    const result = spawnSync('pipx', ['install', '--force', OTEL_HOOKS_PACKAGE], {
      encoding: 'utf8',
      timeout: 180_000,
    });
    if (result.status === 0) {
      return { ok: true, detail: `pipx install ${OTEL_HOOKS_PACKAGE}` };
    }
    return {
      ok: false,
      detail: `pipx install failed: ${(result.stderr || result.stdout || '').trim().slice(0, 400)}`,
    };
  }

  if (commandExists('pip3') || commandExists('pip')) {
    const pip = commandExists('pip3') ? 'pip3' : 'pip';
    const result = spawnSync(
      pip,
      ['install', '--user', OTEL_HOOKS_PACKAGE],
      { encoding: 'utf8', timeout: 180_000 },
    );
    if (result.status === 0) {
      return { ok: true, detail: `${pip} install --user ${OTEL_HOOKS_PACKAGE}` };
    }
    return {
      ok: false,
      detail: `${pip} install failed: ${(result.stderr || result.stdout || '').trim().slice(0, 400)}`,
    };
  }

  return {
    ok: false,
    detail:
      'Neither uv, pipx, nor pip3/pip found; install Python tooling to use opentelemetry-hooks',
  };
}

function runSetupAgent(
  agent: OtelHooksAgent,
  otelHookCommand: string,
  hooksHome: string,
): { ok: boolean; detail: string } {
  const result = spawnSync(otelHookCommand, ['setup', '--agent', agent], {
    encoding: 'utf8',
    env: {
      ...process.env,
      IDE_OTEL_HOOK_HOME: hooksHome,
    },
    timeout: 60_000,
  });
  if (result.status === 0) {
    return { ok: true, detail: `setup --agent ${agent}` };
  }
  return {
    ok: false,
    detail: `setup --agent ${agent} failed: ${(result.stderr || result.stdout || '').trim().slice(0, 400)}`,
  };
}

/**
 * Rewrite hook command entries that invoke otel-hook so they use the HAR wrapper
 * (ensures IDE_OTEL_HOOK_HOME points at ~/.har/otel-hooks).
 */
export function rewriteHookCommandsToWrapper(
  filePath: string,
  wrapperPath: string,
): boolean {
  if (!fs.existsSync(filePath)) return false;
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object') return false;

  const quoted = JSON.stringify(wrapperPath);
  const rewriteCommand = (command: string): string => {
    if (!command.includes('otel-hook') && !command.includes('otel_hook.py')) return command;
    if (command.includes(wrapperPath)) return command;
    // Preserve trailing args if any; replace the executable portion.
    return command.replace(
      /(?:^|[;&|]\s*)(?:env\s+[^=\s]+=\S+\s+)*(?:python3?\s+)?(?:\S*otel[_-]hook\S*)/,
      (match) => match.replace(/(?:python3?\s+)?(?:\S*otel[_-]hook\S*)/, quoted.slice(1, -1)),
    );
  };

  const walk = (node: unknown): boolean => {
    let changed = false;
    if (Array.isArray(node)) {
      for (const item of node) changed = walk(item) || changed;
      return changed;
    }
    if (!node || typeof node !== 'object') return false;
    const obj = node as Record<string, unknown>;
    if (typeof obj.command === 'string') {
      const next = rewriteCommand(obj.command);
      if (next !== obj.command) {
        obj.command = next;
        changed = true;
      }
    }
    for (const value of Object.values(obj)) changed = walk(value) || changed;
    return changed;
  };

  if (!walk(parsed)) return false;
  fs.writeFileSync(filePath, `${JSON.stringify(parsed, null, 2)}\n`);
  return true;
}

function rewriteKnownHookRegistrations(wrapperPath: string): void {
  const home = os.homedir();
  const candidates = [
    path.join(home, '.cursor', 'hooks.json'),
    path.join(home, '.claude', 'settings.json'),
    path.join(home, '.codex', 'hooks.json'),
  ];
  for (const filePath of candidates) {
    try {
      rewriteHookCommandsToWrapper(filePath, wrapperPath);
    } catch {
      // best-effort
    }
  }
}

/**
 * Install opentelemetry-hooks (if needed), write HAR config, register Cursor/Claude/Codex.
 */
export function ensureOtelHooks(options?: {
  setupAgents?: boolean;
  resourceAttributes?: string;
}): EnsureOtelHooksResult {
  const hooksHome = getOtelHooksHome();
  const errors: string[] = [];
  const agentsSetup: OtelHooksAgent[] = [];

  fs.mkdirSync(hooksHome, { recursive: true });

  let otelHookCommand = resolveOtelHookCommand();
  if (!otelHookCommand) {
    const installed = tryInstallPackage();
    if (!installed.ok) {
      errors.push(installed.detail);
      const configPath = writeOtelHooksConfig(
        buildOtelHooksConfig({ resourceAttributes: options?.resourceAttributes }),
        hooksHome,
      );
      return {
        ok: false,
        hooksHome,
        configPath,
        wrapperPath: getOtelHooksWrapperPath(hooksHome),
        otelHookCommand: null,
        warning: installed.detail,
        agentsSetup,
        errors,
      };
    }
    otelHookCommand = resolveOtelHookCommand();
    if (!otelHookCommand) {
      errors.push('opentelemetry-hooks installed but otel-hook is not on PATH');
      const configPath = writeOtelHooksConfig(
        buildOtelHooksConfig({ resourceAttributes: options?.resourceAttributes }),
        hooksHome,
      );
      return {
        ok: false,
        hooksHome,
        configPath,
        wrapperPath: getOtelHooksWrapperPath(hooksHome),
        otelHookCommand: null,
        warning: errors[errors.length - 1],
        agentsSetup,
        errors,
      };
    }
  }

  const configPath = writeOtelHooksConfig(
    buildOtelHooksConfig({ resourceAttributes: options?.resourceAttributes }),
    hooksHome,
  );
  const wrapperPath = writeOtelHooksWrapper(otelHookCommand, hooksHome);

  if (options?.setupAgents !== false && isTelemetryEnabled()) {
    for (const agent of OTEL_HOOKS_AGENTS) {
      const setup = runSetupAgent(agent, otelHookCommand, hooksHome);
      if (setup.ok) agentsSetup.push(agent);
      else errors.push(setup.detail);
    }
    rewriteKnownHookRegistrations(wrapperPath);
  }

  const ok = errors.length === 0;
  return {
    ok,
    hooksHome,
    configPath,
    wrapperPath,
    otelHookCommand,
    message: ok
      ? `opentelemetry-hooks ready (${agentsSetup.join(', ') || 'config only'}) → ${configPath}`
      : undefined,
    warning: errors.length ? errors.join('; ') : undefined,
    agentsSetup,
    errors,
  };
}

/** Refresh config for telemetry off (null endpoint) without uninstalling hooks. */
export function disableOtelHooksExport(): string {
  return writeOtelHooksConfig(buildOtelHooksConfig({ enabled: false }));
}
