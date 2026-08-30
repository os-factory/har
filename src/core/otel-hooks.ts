import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getControlApiUrl } from './control-config';
import { getTelemetrySignals, isTelemetryEnabled } from './telemetry-config';

/** Pinned npm package for reproducible installs (replaces Python opentelemetry-hooks). */
export const OTEL_HOOKS_PACKAGE = '@osfactory/otel-hook@0.2.0';

/**
 * Budgets for the hooks HAR installs into agent settings (#328).
 *
 * A telemetry hook must never cost the user a turn. Hooks fire on session
 * start, every prompt, before and after every tool call, and on stop — so an
 * export that blocks compounds across a single turn. Without an explicit
 * per-hook timeout the agent falls back to its own generous default, and an
 * unreachable Mission Control stalls the session before its first model
 * request, indistinguishable from a broken API.
 *
 * The export budget is deliberately well inside the per-hook ceiling, so the
 * hook returns on its own rather than being killed by the agent. It is also
 * kept small in absolute terms: six or more hooks fire per turn, so every
 * second here is paid several times over whenever the collector is down. A
 * local Mission Control answers in milliseconds, so this costs nothing in the
 * normal case.
 */
export const HOOK_TIMEOUT_SECONDS = 10;
const HOOK_EXPORT_TIMEOUT_MS = 1500;
const HOOK_FLUSH_TIMEOUT_MS = 500;

/** Providers HAR registers with `otel-hook setup --provider`. */
export const OTEL_HOOKS_PROVIDERS = [
  { id: 'cursor', label: 'cursor' },
  { id: 'claude-code', label: 'claude' },
  { id: 'codex', label: 'codex' },
] as const;

export type OtelHooksProviderId = (typeof OTEL_HOOKS_PROVIDERS)[number]['id'];

/** @deprecated Use OTEL_HOOKS_PROVIDERS — kept for callers that still say "agents". */
export const OTEL_HOOKS_AGENTS = ['cursor', 'claude', 'codex'] as const;
export type OtelHooksAgent = (typeof OTEL_HOOKS_AGENTS)[number];

/**
 * HAR-managed `@osfactory/otel-hook` config file (`--config-file`).
 * Shape matches the package's `OtelHookConfigPatch` (not the old Python IDE_OTEL_* keys).
 */
export interface OtelHooksConfig {
  exporter: {
    enabled: boolean;
    endpoint?: string;
    protocol: 'http/protobuf';
    serviceName: string;
    resourceAttributes?: Record<string, string | number | boolean>;
    logs: {
      enabled: boolean;
      endpoint?: string;
      includeContent: boolean;
    };
  };
  privacy: {
    contentMode: 'omit' | 'raw';
    allowRawContent: boolean;
  };
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
  providersSetup: OtelHooksProviderId[];
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

export function getOtelHooksStateDir(hooksHome = getOtelHooksHome()): string {
  return path.join(hooksHome, 'state');
}

function localOtelHookBin(hooksHome: string): string {
  return path.join(hooksHome, 'node_modules', '.bin', 'otel-hook');
}

function installedPackageVersion(hooksHome: string): string | null {
  try {
    const pkgPath = path.join(
      hooksHome,
      'node_modules',
      '@osfactory',
      'otel-hook',
      'package.json',
    );
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

function pinnedVersion(): string {
  const at = OTEL_HOOKS_PACKAGE.lastIndexOf('@');
  // package name is @osfactory/otel-hook@version — split on the last @
  return at > 0 ? OTEL_HOOKS_PACKAGE.slice(at + 1) : OTEL_HOOKS_PACKAGE;
}

/** Parse `OTEL_RESOURCE_ATTRIBUTES` / HAR session attrs into a config object. */
export function parseResourceAttributesString(
  raw: string | null | undefined,
): Record<string, string> {
  if (!raw?.trim()) return {};
  const out: Record<string, string> = {};
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!key || key === 'service.name' || key === 'service.namespace') continue;
    out[key] = value;
  }
  return out;
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
  const resourceAttributes = parseResourceAttributesString(options?.resourceAttributes);
  const capturePrompts = enabled && signals.prompts;

  return {
    exporter: {
      enabled,
      ...(enabled ? { endpoint: `${apiUrl}/api/otel/v1/traces` } : {}),
      protocol: 'http/protobuf',
      serviceName: 'har-ide-agent',
      ...(Object.keys(resourceAttributes).length > 0 ? { resourceAttributes } : {}),
      logs: {
        enabled: enabled && signals.logs,
        ...(enabled && signals.logs ? { endpoint: `${apiUrl}/api/otel/v1/logs` } : {}),
        includeContent: capturePrompts,
      },
    },
    privacy: {
      contentMode: capturePrompts ? 'raw' : 'omit',
      allowRawContent: capturePrompts,
    },
  };
}

export function writeOtelHooksConfig(
  config: OtelHooksConfig,
  hooksHome = getOtelHooksHome(),
): string {
  fs.mkdirSync(hooksHome, { recursive: true });
  const configPath = getOtelHooksConfigPath(hooksHome);
  // Write schema-only JSON — @osfactory/otel-hook rejects unknown keys (e.g. `_comment`)
  // and falls back to defaults with OTLP export disabled.
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return configPath;
}

export function writeOtelHooksWrapper(
  otelHookCommand: string,
  hooksHome = getOtelHooksHome(),
): string {
  fs.mkdirSync(hooksHome, { recursive: true });
  fs.mkdirSync(getOtelHooksStateDir(hooksHome), { recursive: true });
  const wrapperPath = getOtelHooksWrapperPath(hooksHome);
  const configPath = getOtelHooksConfigPath(hooksHome);
  const stateDir = getOtelHooksStateDir(hooksHome);
  const script = `#!/usr/bin/env bash
# Managed by har telemetry — invokes @osfactory/otel-hook with HAR config.
#
# Two rules for this wrapper (#328):
#   1. Bounded. Export and flush budgets keep it well inside the per-hook
#      timeout the agent enforces, so an unreachable Mission Control costs
#      milliseconds instead of stalling the session.
#   2. Silent about its own failures. Dropped telemetry must never fail an
#      agent turn, so the exit status is always 0 — a non-zero hook exit can
#      block a tool call.
set -uo pipefail
"${otelHookCommand}" run \\
  --config-file "${configPath}" \\
  --state-dir "${stateDir}" \\
  --timeout-ms ${HOOK_EXPORT_TIMEOUT_MS} \\
  --flush-timeout-ms ${HOOK_FLUSH_TIMEOUT_MS} \\
  "$@" || true
exit 0
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

function resolveOtelHookCommand(hooksHome: string): string | null {
  const local = localOtelHookBin(hooksHome);
  if (fs.existsSync(local)) return local;
  return null;
}

/**
 * Installer for the private hooks prefix, in preference order. Each writes into
 * `hooksHome/node_modules/.bin`, so a machine with any one of them can run the
 * hook — npm is not a hard requirement.
 */
function resolveHooksInstaller(
  hooksHome: string,
): { command: string; args: string[] } | null {
  const candidates: Array<{ command: string; args: string[] }> = [
    {
      command: 'npm',
      args: ['install', '--prefix', hooksHome, '--no-fund', '--no-audit', OTEL_HOOKS_PACKAGE],
    },
    { command: 'bun', args: ['add', '--cwd', hooksHome, OTEL_HOOKS_PACKAGE] },
    { command: 'pnpm', args: ['add', '--dir', hooksHome, OTEL_HOOKS_PACKAGE] },
  ];
  return candidates.find((candidate) => commandExists(candidate.command)) ?? null;
}

function tryInstallPackage(hooksHome: string): { ok: boolean; detail: string } {
  fs.mkdirSync(hooksHome, { recursive: true });
  const installer = resolveHooksInstaller(hooksHome);
  if (!installer) {
    return {
      ok: false,
      detail: 'no package manager found; install Node.js or bun to use @osfactory/otel-hook',
    };
  }
  const described = `${installer.command} ${installer.args.join(' ')}`;
  const result = spawnSync(installer.command, installer.args, {
    encoding: 'utf8',
    timeout: 180_000,
  });
  if (result.status === 0 && fs.existsSync(localOtelHookBin(hooksHome))) {
    return { ok: true, detail: described };
  }
  return {
    ok: false,
    detail: `${described} failed: ${(result.stderr || result.stdout || '').trim().slice(0, 400)}`,
  };
}

/** Best-effort removal of the legacy Python package so only the TS CLI remains. */
function uninstallLegacyPythonHooks(hooksHome: string): void {
  const attempts: Array<[string, string[]]> = [
    ['uv', ['tool', 'uninstall', 'opentelemetry-hooks']],
    ['pipx', ['uninstall', 'opentelemetry-hooks']],
    ['pip', ['uninstall', '-y', 'opentelemetry-hooks']],
    ['pip3', ['uninstall', '-y', 'opentelemetry-hooks']],
  ];
  for (const [cmd, args] of attempts) {
    if (!commandExists(cmd)) continue;
    try {
      spawnSync(cmd, args, { encoding: 'utf8', timeout: 60_000 });
    } catch {
      // ignore
    }
  }
  removeLegacyPythonArtifacts(hooksHome);
}

/** Drop the old prefix-local Python venv and config files HAR no longer uses. */
function removeLegacyPythonArtifacts(hooksHome: string): void {
  const legacyPaths = [
    path.join(hooksHome, '.venv'),
    path.join(hooksHome, 'otel_config.yaml'),
    path.join(hooksHome, 'venv'),
  ];
  for (const target of legacyPaths) {
    try {
      if (fs.existsSync(target)) {
        fs.rmSync(target, { recursive: true, force: true });
      }
    } catch {
      // best-effort
    }
  }
}

function isOtelHookCommand(command: string, wrapperPath?: string): boolean {
  if (
    command.includes('otel-hook') ||
    command.includes('otel_hook.py') ||
    command.includes('opentelemetry-hooks')
  ) {
    return true;
  }
  return wrapperPath !== undefined && command.includes(wrapperPath);
}

function normalizeLegacyProviderFlagsInCommand(command: string): string {
  return command
    .replace(/(^|\s)--cursor(?=\s|$)/g, '$1--provider cursor')
    .replace(/(^|\s)--claude(?=\s|$)/g, '$1--provider claude-code')
    .replace(/(^|\s)--codex(?=\s|$)/g, '$1--provider codex');
}

/**
 * Cursor events the legacy Python installer registered but the TypeScript
 * otel-hook deliberately skips (duplicate or unpairable telemetry).
 * Keep in sync with otel-hook `CURSOR_UNREGISTERED_HOOK_EVENTS`.
 */
export const LEGACY_CURSOR_ONLY_HOOK_EVENTS = [
  'afterAgentResponse',
  'afterAgentThought',
  'beforeShellExecution',
  'afterShellExecution',
  'beforeMCPExecution',
  'afterMCPExecution',
  'beforeReadFile',
  'subagentStart',
  'subagentStop',
] as const;

/**
 * Argv for `otel-hook setup`, split out so the hook budget is testable without
 * spawning the installer.
 */
export function buildOtelHookSetupArgs(
  providerId: OtelHooksProviderId,
  hookCommand: string,
): string[] {
  return [
    'setup',
    '--provider',
    providerId,
    '--scope',
    'global',
    '--hook-command',
    hookCommand,
    '--managed-marker',
    'otel-hook',
    // Written into each generated hook entry so the agent bounds it (#328).
    // Without this the agent falls back to its own default and an unreachable
    // collector stalls the session before its first model request.
    '--timeout-seconds',
    String(HOOK_TIMEOUT_SECONDS),
  ];
}

function runSetupProvider(
  providerId: OtelHooksProviderId,
  otelHookCommand: string,
  wrapperPath: string,
): { ok: boolean; detail: string } {
  const hookCommand = `${wrapperPath} --provider ${providerId}`;
  const result = spawnSync(otelHookCommand, buildOtelHookSetupArgs(providerId, hookCommand), {
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (result.status === 0) {
    return { ok: true, detail: `setup --provider ${providerId}` };
  }
  return {
    ok: false,
    detail: `setup --provider ${providerId} failed: ${(result.stderr || result.stdout || '').trim().slice(0, 400)}`,
  };
}

/**
 * Rewrite hook command entries that invoke otel-hook so they use the HAR wrapper
 * (ensures --config-file / --state-dir point at ~/.har/otel-hooks).
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

  const rewriteCommand = (command: string): string => {
    if (!isOtelHookCommand(command, wrapperPath)) {
      return command;
    }
    const normalized = normalizeLegacyProviderFlagsInCommand(command);
    if (command.includes(wrapperPath)) {
      return normalized;
    }
    // Preserve current CLI args while translating legacy Python source flags.
    const rewritten = normalized.replace(
      /(?:^|[;&|]\s*)(?:env\s+[^=\s]+=\S+\s+)*(?:python3?\s+)?(?:npx\s+)?(?:\S*otel[_-]hook\S*|\S*opentelemetry-hooks\S*)/,
      (match) =>
        match.replace(
          /(?:python3?\s+)?(?:npx\s+)?(?:\S*otel[_-]hook\S*|\S*opentelemetry-hooks\S*)/,
          wrapperPath,
        ),
    );
    return normalizeLegacyProviderFlagsInCommand(rewritten);
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

/**
 * Remove otel-hook registrations on Cursor events the TypeScript adapter does
 * not manage. The legacy Python installer registered these; they duplicate
 * preToolUse/postToolUse or cannot pair (subagentStop, beforeReadFile).
 */
export function pruneLegacyCursorHookEvents(
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
  const root = parsed as Record<string, unknown>;
  if (!root.hooks || typeof root.hooks !== 'object' || Array.isArray(root.hooks)) {
    return false;
  }
  const hooks = root.hooks as Record<string, unknown>;
  let changed = false;

  for (const event of LEGACY_CURSOR_ONLY_HOOK_EVENTS) {
    const list = hooks[event];
    if (!Array.isArray(list)) continue;
    const kept = list.filter((entry) => {
      if (!entry || typeof entry !== 'object') return true;
      const command = (entry as { command?: unknown }).command;
      if (typeof command !== 'string') return true;
      return !isOtelHookCommand(command, wrapperPath);
    });
    if (kept.length === list.length) continue;
    changed = true;
    if (kept.length === 0) {
      delete hooks[event];
    } else {
      hooks[event] = kept;
    }
  }

  if (!changed) return false;
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
      if (filePath.endsWith(`${path.sep}.cursor${path.sep}hooks.json`)) {
        pruneLegacyCursorHookEvents(filePath, wrapperPath);
      }
    } catch {
      // best-effort
    }
  }
}

function providerLabel(id: OtelHooksProviderId): OtelHooksAgent {
  if (id === 'claude-code') return 'claude';
  if (id === 'cursor') return 'cursor';
  return 'codex';
}

/**
 * Install @osfactory/otel-hook (if needed), write HAR config, register Cursor/Claude/Codex.
 * Replaces the legacy Python opentelemetry-hooks install path.
 */
export function ensureOtelHooks(options?: {
  setupAgents?: boolean;
  resourceAttributes?: string;
}): EnsureOtelHooksResult {
  const hooksHome = getOtelHooksHome();
  const errors: string[] = [];
  const providersSetup: OtelHooksProviderId[] = [];

  fs.mkdirSync(hooksHome, { recursive: true });

  let otelHookCommand = resolveOtelHookCommand(hooksHome);
  const needsInstall =
    !otelHookCommand || installedPackageVersion(hooksHome) !== pinnedVersion();
  if (needsInstall) {
    // Prefer a prefix-local install so HAR pins the version under ~/.har/otel-hooks.
    const installed = tryInstallPackage(hooksHome);
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
        agentsSetup: [],
        providersSetup,
        errors,
      };
    }
    otelHookCommand = resolveOtelHookCommand(hooksHome);
    if (!otelHookCommand) {
      errors.push('@osfactory/otel-hook installed but otel-hook binary is missing');
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
        agentsSetup: [],
        providersSetup,
        errors,
      };
    }
  }

  const resolvedCommand = otelHookCommand;
  if (!resolvedCommand) {
    errors.push('@osfactory/otel-hook binary is missing');
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
      agentsSetup: [],
      providersSetup,
      errors,
    };
  }

  const configPath = writeOtelHooksConfig(
    buildOtelHooksConfig({ resourceAttributes: options?.resourceAttributes }),
    hooksHome,
  );
  const wrapperPath = writeOtelHooksWrapper(resolvedCommand, hooksHome);
  // Remove the old Python tool only after the npm replacement and wrapper are
  // ready. If npm installation fails, an existing HAR hook remains usable.
  uninstallLegacyPythonHooks(hooksHome);

  if (options?.setupAgents !== false && isTelemetryEnabled()) {
    for (const provider of OTEL_HOOKS_PROVIDERS) {
      const setup = runSetupProvider(provider.id, resolvedCommand, wrapperPath);
      if (setup.ok) providersSetup.push(provider.id);
      else errors.push(setup.detail);
    }
    rewriteKnownHookRegistrations(wrapperPath);
  }

  const agentsSetup = providersSetup.map(providerLabel);
  const ok = errors.length === 0;
  return {
    ok,
    hooksHome,
    configPath,
    wrapperPath,
    otelHookCommand: resolvedCommand,
    message: ok
      ? `@osfactory/otel-hook ready (${agentsSetup.join(', ') || 'config only'}) → ${configPath}`
      : undefined,
    warning: errors.length ? errors.join('; ') : undefined,
    agentsSetup,
    providersSetup,
    errors,
  };
}

/** Refresh config for telemetry off (exporter disabled) without uninstalling hooks. */
export function disableOtelHooksExport(): string {
  return writeOtelHooksConfig(buildOtelHooksConfig({ enabled: false }));
}
