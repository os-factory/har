import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  disableClaudeNativeTelemetry,
  enableClaudeNativeTelemetry,
} from './claude-native-telemetry';
import { getControlApiUrl } from './control-config';
import {
  getTelemetryLevel,
  getTelemetrySignals,
  isTelemetryEnabled,
  signalsForLevel,
  type TelemetryLevel,
} from './telemetry-config';
import {
  DIRECT_STRIP_LOCAL_ENV,
  HAR_RESOURCE_ATTRIBUTES_ENV,
  directRouteSendsLogs,
  directRouteStripsLocalPaths,
  planDirectDestinations,
  getDirectExportEnvPath,
  readAppliedDirectRoute,
  resolveAgentTelemetryRoute,
  writeDirectExportEnv,
  type AgentTelemetryRoute,
  type AgentTelemetryRouteDecision,
} from './telemetry-direct';
import { LOCAL_ATTR_PREFIX } from '../harness/schema';

/** Pinned npm package for reproducible installs (replaces Python opentelemetry-hooks). */
export const OTEL_HOOKS_PACKAGE = '@osfactory/otel-hook@0.9.0';

/**
 * Environment override for the package spec HAR installs: any spec the package
 * manager accepts (`@osfactory/otel-hook@0.9.0`, a local `.tgz`, a directory).
 * For dogfooding an unreleased otel-hook build; unset, HAR installs the pin.
 */
export const OTEL_HOOKS_PACKAGE_ENV = 'HAR_OTEL_HOOKS_PACKAGE';

/** The package spec HAR installs: the override when set, else the pin. */
export function otelHooksPackageSpec(env: NodeJS.ProcessEnv = process.env): string {
  return env[OTEL_HOOKS_PACKAGE_ENV]?.trim() || OTEL_HOOKS_PACKAGE;
}

/** Records the spec of the last install, so a changed override reinstalls. */
const INSTALLED_SPEC_FILE = '.har-package-spec';

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
/**
 * One `exporter.destinations[]` entry (otel-hook >= 0.9.0). Header values are
 * always `env:<VAR>` references to `direct.env`, never the secret itself.
 */
export interface OtelHooksDestinationConfig {
  name: string;
  tracesEndpoint?: string;
  logsEndpoint?: string;
  headers?: Record<string, string>;
  signals: Array<'traces' | 'logs'>;
}

export interface OtelHooksConfig {
  exporter: {
    enabled: boolean;
    endpoint?: string;
    protocol: 'http/protobuf';
    serviceName: string;
    resourceAttributes?: Record<string, string | number | boolean>;
    /** Direct export to two or more destinations; absent otherwise. */
    destinations?: OtelHooksDestinationConfig[];
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
  /** Where agent hook traces go now (see `telemetry-direct.ts`). */
  route: AgentTelemetryRoute;
  /** Why direct export was not used, when it might have been expected. */
  routeHint?: string;
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

function installedSpec(hooksHome: string): string | null {
  try {
    return fs.readFileSync(path.join(hooksHome, INSTALLED_SPEC_FILE), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

export function recordInstalledSpec(hooksHome: string, spec: string): void {
  try {
    fs.writeFileSync(path.join(hooksHome, INSTALLED_SPEC_FILE), `${spec}\n`);
  } catch {
    // best-effort: a missing record only means the next run reinstalls
  }
}

/**
 * Whether the hooks prefix needs a (re)install. The pin is checked by the
 * installed version; an override, whose version HAR cannot know up front, by
 * the spec recorded at install time. Switching between them reinstalls.
 */
export function needsPackageInstall(hooksHome: string, spec: string): boolean {
  const recorded = installedSpec(hooksHome);
  if (spec !== OTEL_HOOKS_PACKAGE) return recorded !== spec;
  if (recorded !== null && recorded !== spec) return true;
  return installedPackageVersion(hooksHome) !== pinnedVersion();
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
  /**
   * Where traces go (default: Mission Control). A direct route writes no
   * endpoint here — `exporter.endpoint` would outrank the standard
   * `OTEL_EXPORTER_OTLP_*` variables the wrapper loads from `direct.env`.
   */
  route?: AgentTelemetryRoute;
}): OtelHooksConfig {
  // Every switch comes from the level: the hook exports spans from Outline up,
  // its event records (the only channel that carries text) alongside them,
  // and the text itself only at Full.
  const signals = options?.enabled === false ? signalsForLevel('off') : getTelemetrySignals();
  const enabled = signals.traces;
  const apiUrl = (options?.apiUrl ?? getControlApiUrl()).replace(/\/$/, '');
  const direct = options?.route?.mode === 'direct' ? options.route.destinations : undefined;
  const resourceAttributes = parseResourceAttributesString(options?.resourceAttributes);
  if (direct && directRouteStripsLocalPaths(direct)) {
    // Nothing strips the Resource on the direct path, and every destination gets the same one.
    for (const key of Object.keys(resourceAttributes)) {
      if (key.startsWith(LOCAL_ATTR_PREFIX)) delete resourceAttributes[key];
    }
  }
  const logsEnabled = enabled && signals.logs && (!direct || directRouteSendsLogs(direct));
  const capturePrompts = logsEnabled && signals.prompts;
  // One destination rides the standard OTLP variables in direct.env; the list is for two or more.
  const destinations =
    enabled && direct && direct.length > 1
      ? planDirectDestinations(direct).map(
          (plan): OtelHooksDestinationConfig => ({
            name: plan.name,
            ...(plan.tracesEndpoint ? { tracesEndpoint: plan.tracesEndpoint } : {}),
            ...(plan.logsEndpoint ? { logsEndpoint: plan.logsEndpoint } : {}),
            ...(plan.headers.length > 0
              ? { headers: Object.fromEntries(plan.headers.map((binding) => [binding.header, `env:${binding.envVar}`])) }
              : {}),
            signals: plan.signals,
          }),
        )
      : undefined;

  return {
    exporter: {
      enabled,
      ...(enabled && !direct ? { endpoint: `${apiUrl}/api/otel/v1/traces` } : {}),
      // otel-hook exports OTLP/HTTP protobuf only; every OTLP/HTTP receiver takes it.
      protocol: 'http/protobuf',
      serviceName: 'har-ide-agent',
      ...(Object.keys(resourceAttributes).length > 0 ? { resourceAttributes } : {}),
      ...(destinations ? { destinations } : {}),
      logs: {
        enabled: logsEnabled,
        ...(logsEnabled && !direct ? { endpoint: `${apiUrl}/api/otel/v1/logs` } : {}),
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
  const directEnvPath = getDirectExportEnvPath(hooksHome);
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
# Claude Code (>= 2.1.128) removes every OTEL_* variable from the hooks it runs
# (#484): restore the session profile from the copy HAR writes next to it in
# .env.agent.<id>. Before the strip below, so the privacy filter still applies.
if [ -z "\${OTEL_RESOURCE_ATTRIBUTES:-}" ] && [ -n "\${${HAR_RESOURCE_ATTRIBUTES_ENV}:-}" ]; then
  export OTEL_RESOURCE_ATTRIBUTES="$${HAR_RESOURCE_ATTRIBUTES_ENV}"
fi
# Direct export (Mission Control off): endpoints and header values live in a
# mode-0600 file, never in this script, the hook config or on a command line.
if [ -f "${directEnvPath}" ]; then
  . "${directEnvPath}" || true
fi
# Nothing strips the Resource on the direct path: drop local-only paths.
if [ -n "\${${DIRECT_STRIP_LOCAL_ENV}:-}" ] && [ -n "\${OTEL_RESOURCE_ATTRIBUTES:-}" ]; then
  _har_kept=""
  IFS=',' read -ra _har_parts <<< "$OTEL_RESOURCE_ATTRIBUTES"
  for _har_part in "\${_har_parts[@]}"; do
    case "\${_har_part#"\${_har_part%%[![:space:]]*}"}" in
      ${LOCAL_ATTR_PREFIX}*) ;;
      *) _har_kept="\${_har_kept:+$_har_kept,}$_har_part" ;;
    esac
  done
  export OTEL_RESOURCE_ATTRIBUTES="$_har_kept"
fi
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
  spec: string,
): { command: string; args: string[] } | null {
  const candidates: Array<{ command: string; args: string[] }> = [
    {
      command: 'npm',
      args: ['install', '--prefix', hooksHome, '--no-fund', '--no-audit', spec],
    },
    { command: 'bun', args: ['add', '--cwd', hooksHome, spec] },
    { command: 'pnpm', args: ['add', '--dir', hooksHome, spec] },
  ];
  return candidates.find((candidate) => commandExists(candidate.command)) ?? null;
}

function tryInstallPackage(hooksHome: string, spec: string): { ok: boolean; detail: string } {
  fs.mkdirSync(hooksHome, { recursive: true });
  const installer = resolveHooksInstaller(hooksHome, spec);
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
    recordInstalledSpec(hooksHome, spec);
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
  const packageSpec = otelHooksPackageSpec();
  const needsInstall = !otelHookCommand || needsPackageInstall(hooksHome, packageSpec);
  if (needsInstall) {
    // Prefer a prefix-local install so HAR pins the version under ~/.har/otel-hooks.
    const installed = tryInstallPackage(hooksHome, packageSpec);
    if (!installed.ok) {
      errors.push(installed.detail);
      const { configPath, decision } = applyAgentTelemetryRoute(hooksHome, options?.resourceAttributes);
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
        route: decision.route,
        routeHint: decision.hint,
      };
    }
    otelHookCommand = resolveOtelHookCommand(hooksHome);
    if (!otelHookCommand) {
      errors.push('@osfactory/otel-hook installed but otel-hook binary is missing');
      const { configPath, decision } = applyAgentTelemetryRoute(hooksHome, options?.resourceAttributes);
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
        route: decision.route,
        routeHint: decision.hint,
      };
    }
  }

  const resolvedCommand = otelHookCommand;
  if (!resolvedCommand) {
    errors.push('@osfactory/otel-hook binary is missing');
    const { configPath, decision } = applyAgentTelemetryRoute(hooksHome, options?.resourceAttributes);
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
      route: decision.route,
      routeHint: decision.hint,
    };
  }

  const { configPath, decision } = applyAgentTelemetryRoute(hooksHome, options?.resourceAttributes);
  const wrapperPath = writeOtelHooksWrapper(resolvedCommand, hooksHome);
  // Remove the old Python tool only after the npm replacement and wrapper are
  // ready. If npm installation fails, an existing HAR hook remains usable.
  uninstallLegacyPythonHooks(hooksHome);

  const signals = getTelemetrySignals();
  if (options?.setupAgents !== false && isTelemetryEnabled()) {
    // Hooks only export from Outline up; at Usage the agents' own telemetry
    // and session files carry everything, so no hook needs to run.
    if (signals.traces) {
      for (const provider of OTEL_HOOKS_PROVIDERS) {
        const setup = runSetupProvider(provider.id, resolvedCommand, wrapperPath);
        if (setup.ok) providersSetup.push(provider.id);
        else errors.push(setup.detail);
      }
    }
    rewriteKnownHookRegistrations(wrapperPath);
  }
  if (options?.setupAgents !== false) {
    // Claude reports tokens/cost to no hook — its native metrics and
    // per-request `api_request` log events carry them (ADR 0003).
    try {
      // Direct mode: Claude's native metrics and logs carry account identity
      // and nothing would strip it on the way to a third-party backend.
      if (signals.metrics && decision.route.mode !== 'direct') {
        const claude = enableClaudeNativeTelemetry({ hooksHome });
        if (claude.skipped.length > 0) {
          errors.push(
            `Claude native telemetry: left your own ${claude.skipped.join(', ')} in ${claude.settingsPath} — Claude cost needs them pointed at Mission Control`,
          );
        }
      } else {
        disableClaudeNativeTelemetry({ hooksHome });
      }
    } catch (err) {
      errors.push(`Claude native telemetry not configured: ${err instanceof Error ? err.message : String(err)}`);
    }
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
    route: decision.route,
    routeHint: decision.hint,
  };
}

/**
 * Resolve where agent traces go and write what the hook reads for it: the
 * config file, and `direct.env` (0600) for a direct route or its removal.
 */
export function applyAgentTelemetryRoute(
  hooksHome = getOtelHooksHome(),
  resourceAttributes?: string,
): { configPath: string; decision: AgentTelemetryRouteDecision } {
  const decision = resolveAgentTelemetryRoute(hooksHome);
  const configPath = writeOtelHooksConfig(
    buildOtelHooksConfig({ resourceAttributes, route: decision.route }),
    hooksHome,
  );
  writeDirectExportEnv(decision.route, hooksHome);
  return { configPath, decision };
}

/**
 * Re-route agent traces after something they depend on changed (a destination
 * added or removed, Mission Control started or stopped), without installing or
 * registering anything. A no-op until `har telemetry on` installed the hook.
 * Fail-open: returns undefined on any error.
 */
export function refreshAgentTelemetryRoute(): AgentTelemetryRouteDecision | undefined {
  try {
    const hooksHome = getOtelHooksHome();
    const command = resolveOtelHookCommand(hooksHome);
    if (!command) {
      writeDirectExportEnv({ mode: 'off' }, hooksHome);
      return undefined;
    }
    if (!isTelemetryEnabled()) {
      writeDirectExportEnv({ mode: 'off' }, hooksHome);
      return { route: { mode: 'off' } };
    }
    const wasDirect = readAppliedDirectRoute(hooksHome) !== null;
    const { decision } = applyAgentTelemetryRoute(hooksHome);
    // Wrappers written before direct mode do not source direct.env.
    writeOtelHooksWrapper(command, hooksHome);
    // Claude's native telemetry follows the mode only when the mode changed.
    try {
      if (decision.route.mode === 'direct') {
        disableClaudeNativeTelemetry({ hooksHome });
      } else if (wasDirect && getTelemetrySignals().metrics) {
        enableClaudeNativeTelemetry({ hooksHome });
      }
    } catch {
      // best-effort: a malformed settings file must not block the refresh
    }
    return decision;
  } catch {
    return undefined;
  }
}

/** Refresh config for telemetry off (exporter disabled) without uninstalling hooks. */
export function disableOtelHooksExport(): string {
  try {
    writeDirectExportEnv({ mode: 'off' }, getOtelHooksHome());
  } catch {
    // best-effort
  }
  try {
    disableClaudeNativeTelemetry({ hooksHome: getOtelHooksHome() });
  } catch {
    // best-effort: a malformed settings file must not block telemetry off
  }
  return writeOtelHooksConfig(buildOtelHooksConfig({ enabled: false }));
}

export interface TelemetryDrift {
  level: TelemetryLevel;
  configPath: string;
  /** Each way the hook config on disk records more or less than the level asks for. */
  mismatches: string[];
}

/**
 * Compare the hook config agents actually read with what the effective level
 * asks for. A preference changed by hand, or a level chosen before this
 * version, leaves the file behind — agents then record less (or more) than
 * `har telemetry status` claims.
 */
export function inspectTelemetryDrift(hooksHome = getOtelHooksHome()): TelemetryDrift {
  const level = getTelemetryLevel();
  const configPath = getOtelHooksConfigPath(hooksHome);
  const applied = readAppliedDirectRoute(hooksHome);
  const expected = buildOtelHooksConfig();
  // A direct route sends event records only when its destination subscribes to logs.
  if (applied && !applied.logs) {
    expected.exporter.logs.enabled = false;
    expected.exporter.logs.includeContent = false;
    expected.privacy.contentMode = 'omit';
  }
  const mismatches: string[] = [];
  let actual: Partial<OtelHooksConfig> | null = null;
  try {
    actual = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Partial<OtelHooksConfig>;
  } catch {
    actual = null;
  }
  if (!actual) {
    if (expected.exporter.enabled) mismatches.push('no hook config written yet');
    return { level, configPath, mismatches };
  }
  const check = (label: string, want: unknown, got: unknown) => {
    if (want !== got) mismatches.push(`${label}: ${String(got)} (level ${level} needs ${String(want)})`);
  };
  check('spans export', expected.exporter.enabled, actual.exporter?.enabled ?? false);
  check('event records export', expected.exporter.logs.enabled, actual.exporter?.logs?.enabled ?? false);
  check('text capture', expected.exporter.logs.includeContent, actual.exporter?.logs?.includeContent ?? false);
  check('content mode', expected.privacy.contentMode, actual.privacy?.contentMode ?? 'omit');
  return { level, configPath, mismatches };
}
