import * as path from 'path';
import { readManifest, resolveHarnessRoot } from '../harness/manifest';
import { readStageRegistry } from '../harness/stages';
import {
  EnvironmentStatus,
  RegisterRepoInput,
  RunRecord,
  SyncRunsInputSchema,
  SyncSlotsInputSchema,
  SyncWorkUnitsInputSchema,
  SyncValidationBindingsInputSchema,
  SyncSessionEventsInputSchema,
  SyncUsageInputSchema,
  SyncValidationsInputSchema,
} from '../harness/schema';
import {
  getControlApiUrl,
  isControlEnabled,
  PortalTarget,
} from './control-config';
import {
  isRepoPortalSyncEnabled,
  listRegisteredRepos,
  recordRepoForControlSync,
  removeRegisteredRepo,
} from './control-registry';
import { readPortalCredentials } from './portal-credentials';
import {
  isPortalTrajectoryEnabledForTarget,
  resolvePortalTargetsForRepo,
  updatePortalTargetTokens,
} from './portal-targets';
import { canonicalizeControlRepoPath } from './control-repo-path';
import {
  collectRunsBySource,
  collectRunsForSync,
  mergeRunsBySource,
  RunsBySource,
  collectValidationBindingsForSync,
  collectValidationsForSync,
  collectWorkUnitsForSync,
  resolveSyncSourcePaths,
  selectRunsForSync,
} from './sync-sources';
import { collectEnvironmentStatus } from './slot-status';
import { listValidations } from './validations';
import {
  listValidationBindings,
} from './work-units';
import { createRemoteExecutor } from './cloud-executor';
import { getTelemetrySignals, isTelemetryEnabled } from './telemetry-config';
import { getHarPackageVersion } from './package-version';
import { warn } from '../utils/logging';
import { harvestEventsForSlot, harvestUsageForSlot, omitHarvestEventsWhenOtelPresent, omitHarvestWhenOtelPresent } from './usage-harvest';
import { buildSessionKey } from './telemetry-env';
import { fetchPersistedPortalTelemetry } from './control-persisted-usage';
import type { ChannelReadFailure } from './control-api-read';
import { fetchPersistedTrajectory } from './control-persisted-trajectory';
import { dedupePortalEvents, mergePortalUsage } from './portal-usage-merge';
import { enrichUsageWithPricing } from '../harness/schema';
import {
  readPortalWatermark,
  writePortalWatermark,
  coveredSources,
  readRunsWatermarkEntry,
  writeRunsWatermark,
  selectSince,
} from './portal-watermark';
import type { AgentSessionEvent, AgentSessionUsage } from '../harness/schema';

export interface ControlSyncOptions {
  repoPath: string;
  apiUrl?: string;
  dryRun?: boolean;
  cloud?: boolean;
  /** Re-register even if the path was previously unregistered. */
  force?: boolean;
  /** Ignore the portal watermark and resend the complete persisted payload. */
  full?: boolean;
  /** Named portal target aliases for an explicit sync (comma-separated on CLI). */
  portalTargets?: string[];
}

export interface SyncRepoResult {
  repoPath: string;
  ok: boolean;
  error?: string;
  warnings?: string[];
  targets?: Array<{ alias: string; ok: boolean; error?: string; warnings?: string[] }>;
}

export interface ControlRegisterOptions extends ControlSyncOptions {
  gitRemote?: string;
}

/** Per-request byte cap: a single POST of a large run history gets the connection
 * dropped (undici UND_ERR_SOCKET), so unbounded collections chunk under this. */
const DEFAULT_MAX_BATCH_BYTES = 4 * 1024 * 1024;

function maxSyncBatchBytes(): number {
  const raw = Number(process.env.HAR_SYNC_MAX_BATCH_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_BATCH_BYTES;
}

export function chunkBySerializedSize<T>(items: T[], maxBytes: number): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let currentBytes = 0;

  for (const item of items) {
    const itemBytes = Buffer.byteLength(JSON.stringify(item), 'utf8');
    if (current.length > 0 && currentBytes + itemBytes > maxBytes) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(item);
    currentBytes += itemBytes;
  }
  if (current.length > 0) batches.push(current);

  return batches;
}

function runTimestamp(run: RunRecord): string {
  return run.finishedAt ?? run.startedAt;
}

// Re-send a small window past the watermark so a same-ms sibling or a backward
// clock step isn't dropped (the resend is an idempotent upsert).
const DEFAULT_SYNC_OVERLAP_MS = 60_000;

function rewindSince(since: string | null): string | null {
  if (!since) return null;
  const raw = Number(process.env.HAR_SYNC_OVERLAP_MS);
  const overlap = Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_SYNC_OVERLAP_MS;
  return new Date(new Date(since).getTime() - overlap).toISOString();
}

function watermarkKeyForTarget(target: PortalTarget): string {
  return target.identityKey;
}

function legacyWatermarkKeysForTarget(target: PortalTarget): string[] {
  return target.url === target.identityKey ? [] : [target.url];
}

function readScopedPortalWatermark(
  repoPath: string,
  scopedKey: string,
  legacyScopedKeys: string[] = [],
): string | null {
  const direct = readPortalWatermark(repoPath, scopedKey);
  if (direct) return direct;
  for (const legacyKey of legacyScopedKeys) {
    const legacy = readPortalWatermark(repoPath, legacyKey);
    if (legacy) return legacy;
  }
  return null;
}

function legacyScopedWatermarkKeys(portal: PortalTarget, prefix: string): string[] {
  if (portal.url === portal.identityKey) return [];
  return [`${prefix}:${portal.url}`];
}

function runsWatermarkTargetForPortal(target: PortalTarget): string {
  return runsWatermarkTarget(watermarkKeyForTarget(target));
}

function readPortalWatermarkForTarget(repoPath: string, target: PortalTarget): string | null {
  return readScopedPortalWatermark(
    repoPath,
    watermarkKeyForTarget(target),
    legacyWatermarkKeysForTarget(target),
  );
}

function trajectoryWatermarkTarget(target: PortalTarget): string {
  return `trajectory:${watermarkKeyForTarget(target)}`;
}

function spansWatermarkTarget(target: PortalTarget): string {
  return `spans:${watermarkKeyForTarget(target)}`;
}

function runsWatermarkTarget(target: string): string {
  return `runs:${target}`;
}

/** Send run batches oldest-first, advancing the watermark (with the server repo
 * id) after each lands — so a sync killed mid-flight resumes, and a wiped repo
 * invalidates it. */
async function syncRunBatches(
  newRuns: RunRecord[],
  repoPath: string,
  runsTarget: string,
  getRepoId: () => string | undefined,
  dryRun: boolean | undefined,
  send: (batch: RunRecord[], index: number) => Promise<void>,
  sources?: string[],
): Promise<void> {
  const ordered = [...newRuns].sort((a, b) => runTimestamp(a).localeCompare(runTimestamp(b)));
  const batches = chunkBySerializedSize(ordered, maxSyncBatchBytes());
  const toSend = batches.length > 0 ? batches : [[]];
  for (let i = 0; i < toSend.length; i++) {
    const batch = toSend[i];
    await send(batch, i);
    if (!dryRun && batch.length > 0) {
      writeRunsWatermark(
        repoPath,
        runsTarget,
        getRepoId(),
        runTimestamp(batch[batch.length - 1]),
        sources,
      );
    }
  }
}

function describeFetchFailure(url: string, bodyBytes: number, err: unknown): string {
  const base = err instanceof Error ? err.message : String(err);
  const cause = (err as { cause?: { code?: string; message?: string } }).cause;
  const code = cause?.code ? ` [${cause.code}]` : '';
  const detail = cause?.message && cause.message !== base ? `: ${cause.message}` : '';
  const size = bodyBytes > 0 ? ` (request body ${(bodyBytes / 1024 / 1024).toFixed(2)} MB)` : '';
  return `${base}${code}${detail}${size} — POST ${url}`;
}

const MAX_FETCH_ATTEMPTS = 3;

async function postForResponse(
  url: string,
  headers: Record<string, string>,
  payload: string,
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
    try {
      return await fetch(url, { method: 'POST', headers, body: payload });
    } catch (err) {
      // Retry network throws (e.g. a keep-alive socket dropped after a big batch)
      // — every sync POST is an idempotent upsert, so a fresh connection is safe.
      lastErr = err;
      if (attempt < MAX_FETCH_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 100));
      }
    }
  }
  throw new Error(describeFetchFailure(url, Buffer.byteLength(payload, 'utf8'), lastErr));
}

async function postJson<T>(url: string, body: unknown, dryRun?: boolean): Promise<T | null> {
  if (dryRun) return null;

  const response = await postForResponse(
    url,
    { 'Content-Type': 'application/json' },
    JSON.stringify(body),
  );

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Control API ${response.status}: ${text || response.statusText}`);
  }

  return (await response.json()) as T;
}

function postPortalOnce(
  target: PortalTarget,
  endpoint: string,
  body: unknown,
): Promise<Response> {
  return postForResponse(
    `${target.url}${endpoint}`,
    {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${target.token}`,
    },
    JSON.stringify(body),
  );
}

// Rotate an expired ingest token via the stored refresh token: on success
// mutates target.token and persists the rotated credential, else returns false
// so the caller surfaces the original 401.
async function refreshPortalToken(target: PortalTarget): Promise<boolean> {
  if (!target.refreshToken) return false;

  let response: Response;
  try {
    response = await fetch(`${target.url}/api/cli/refresh`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${target.refreshToken}` },
    });
  } catch {
    return false;
  }
  if (!response.ok) return false;

  const data = (await response.json().catch(() => null)) as {
    token?: string;
    expiresAt?: string;
  } | null;
  if (!data?.token) return false;

  target.token = data.token;
  if (target.alias) {
    updatePortalTargetTokens(target.alias, {
      token: data.token,
      expiresAt: data.expiresAt,
    });
  }
  return true;
}

async function postPortalWithRefresh(
  target: PortalTarget,
  endpoint: string,
  body: unknown,
): Promise<Response> {
  const response = await postPortalOnce(target, endpoint, body);

  if (
    (response.status === 401 || response.status === 403) &&
    (await refreshPortalToken(target))
  ) {
    return postPortalOnce(target, endpoint, body);
  }

  return response;
}

async function throwPortalFailure(response: Response): Promise<never> {
  if (response.status === 401 || response.status === 403) {
    throw new Error(
      `har-portal rejected the ingest token (HTTP ${response.status}) — run \`har hq connect\` (or check HAR_PORTAL_TOKEN).`,
    );
  }
  const text = await response.text().catch(() => '');
  throw new Error(`har-portal sync failed: HTTP ${response.status}${text ? ` — ${text}` : ''}`);
}

async function postPortal(
  target: PortalTarget,
  endpoint: string,
  body: unknown,
  dryRun?: boolean,
): Promise<Record<string, unknown> | null> {
  if (dryRun) return null;

  const response = await postPortalWithRefresh(target, endpoint, body);
  if (!response.ok) await throwPortalFailure(response);

  return (await response.json().catch(() => null)) as Record<string, unknown> | null;
}

async function postPortalIfSupported(
  target: PortalTarget,
  endpoint: string,
  body: unknown,
  dryRun?: boolean,
): Promise<boolean> {
  if (dryRun) return true;

  const response = await postPortalWithRefresh(target, endpoint, body);
  if (response.status === 404) return false;
  if (!response.ok) await throwPortalFailure(response);

  return true;
}

function resolvePortalUserEmail(target?: PortalTarget): string | undefined {
  if (target?.email) return target.email;
  return readPortalCredentials()?.email || undefined;
}

function dropNullFields(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== null));
}

function modelsFromBreakdown(
  breakdown: Record<string, unknown> | undefined,
): Record<string, unknown>[] {
  if (!breakdown) return [];
  return Object.entries(breakdown).map(([model, totals]) => ({
    model,
    ...(totals && typeof totals === 'object' ? totals : {}),
  }));
}

interface TelemetryCollection {
  usage: Record<string, unknown>[];
  events: Record<string, unknown>[];
  maxSyncedAt: string | null;
  failures: ChannelReadFailure[];
  truncated: string[];
}

function describeReadFailures(repoPath: string, failures: ChannelReadFailure[]): string {
  const detail = failures.map((f) => `${f.channel} (${f.reason})`).join(', ');
  return (
    `${path.basename(repoPath)}: could not read ${detail} from Mission Control — ` +
    'that telemetry is missing from this sync and its watermark is held, so the next sync retries it.'
  );
}

function describeTruncatedReads(repoPath: string, channels: string[]): string {
  return (
    `${path.basename(repoPath)}: ${channels.join(', ')} hit the read page cap — ` +
    'the remainder syncs on the next run.'
  );
}

async function collectPortalTelemetry(
  repoPath: string,
  slots: EnvironmentStatus['slots'],
  controlApiUrl: string,
  since: string | null,
  portal?: PortalTarget,
): Promise<TelemetryCollection> {
  if (!isTelemetryEnabled()) {
    return { usage: [], events: [], maxSyncedAt: null, failures: [], truncated: [] };
  }
  try {
    const userEmail = resolvePortalUserEmail(portal);
    const fallbackAgentId =
      slots.length > 0 ? Math.min(...slots.map((slot) => slot.agentId)) : null;
    const liveUsage: AgentSessionUsage[] = slots.flatMap((slot) =>
      harvestUsageForSlot({
        agentId: slot.agentId,
        workDir: slot.workDir,
        worktreePath: slot.worktreePath,
        branch: slot.branch,
        suffix: slot.suffix,
        sessionCreatedAt: slot.sessionCreatedAt,
        repoPath,
        includeRepoPathFallback: slot.agentId === fallbackAgentId,
      }).map((row) => ({
        ...row,
        workUnitId: slot.workUnitId ?? row.workUnitId,
        attemptId: slot.attemptId ?? row.attemptId,
        sessionKey:
          row.sessionKey ||
          buildSessionKey({
            branch: slot.branch,
            agentId: slot.agentId,
            suffix: slot.suffix,
            createdAt: slot.sessionCreatedAt,
          }),
      })),
    );

    const liveEvents: AgentSessionEvent[] = slots.flatMap((slot) =>
      harvestEventsForSlot({
        agentId: slot.agentId,
        workDir: slot.workDir,
        worktreePath: slot.worktreePath,
        branch: slot.branch,
        suffix: slot.suffix,
        sessionCreatedAt: slot.sessionCreatedAt,
        repoPath,
        includeRepoPathFallback: slot.agentId === fallbackAgentId,
      }).map((event) => ({
        ...event,
        workUnitId: slot.workUnitId ?? event.workUnitId,
        attemptId: slot.attemptId ?? event.attemptId,
      })),
    );

    const persisted = await fetchPersistedPortalTelemetry(repoPath, controlApiUrl, { since });

    const harvestedUsage = omitHarvestWhenOtelPresent(liveUsage, persisted.usage);
    const harvestedEvents = omitHarvestEventsWhenOtelPresent(liveEvents, persisted.events);

    const usage = mergePortalUsage(harvestedUsage, persisted.usage).map((row) => {
      const priced = enrichUsageWithPricing(row);
      const models = modelsFromBreakdown(
        priced.modelBreakdown as Record<string, unknown> | undefined,
      );
      return {
        ...priced,
        ...(userEmail ? { userEmail } : {}),
        ...(models.length > 0 ? { models } : {}),
      };
    });

    const events = dedupePortalEvents(harvestedEvents, persisted.events).map((event) =>
      dropNullFields({ ...event }),
    );

    return {
      usage,
      events,
      maxSyncedAt: persisted.maxSyncedAt,
      failures: persisted.failures,
      truncated: persisted.truncated,
    };
  } catch (err: unknown) {
    return {
      usage: [],
      events: [],
      maxSyncedAt: null,
      failures: [
        { channel: 'telemetry', reason: err instanceof Error ? err.message : String(err) },
      ],
      truncated: [],
    };
  }
}

async function buildPortalPayload(
  repoPath: string,
  sourcePaths: string[],
  controlApiUrl: string,
  since: string | null,
  full = false,
  portal?: PortalTarget,
): Promise<{
  syncBody: Record<string, unknown>;
  runs: RunRecord[];
  runsBySource: RunsBySource[];
  events: Record<string, unknown>[];
  maxSyncedAt: string | null;
  failures: ChannelReadFailure[];
  truncated: string[];
}> {
  // Same canonical-identity / workspace-evidence split as the local path (#255).
  const rawRunsBySource = collectRunsBySource(sourcePaths);
  const runs = mergeRunsBySource(rawRunsBySource);
  const status = collectEnvironmentStatus(repoPath);
  const manifest = readManifest(repoPath);
  const stagesRegistry = readStageRegistry(repoPath);
  const validations = collectValidationsForSync(sourcePaths);
  const { workUnits, attempts } = collectWorkUnitsForSync(sourcePaths);
  const validationBindings = collectValidationBindingsForSync(sourcePaths);
  // Attribute runs/validations to the syncing member so the portal can resolve
  // a real user FK instead of the lossy (repo, agentId) derivation.
  const userEmail = resolvePortalUserEmail(portal);
  const { usage, events, maxSyncedAt, failures, truncated } = await collectPortalTelemetry(
    repoPath,
    status.slots,
    controlApiUrl,
    since,
    portal,
  );

  if (
    full &&
    isTelemetryEnabled() &&
    failures.length === 0 &&
    usage.length === 0 &&
    runs.some((r) => r.agentId != null)
  ) {
    warn(
      `${path.basename(repoPath)}: agent runs found but no usage harvested — attribution will be missing. ` +
        'This happens when agent sessions ran outside the har worktree slot (e.g. in the main checkout). ' +
        'Run agents inside `har env launch`.',
    );
  }

  if (full && isTelemetryEnabled() && !getTelemetrySignals().prompts) {
    warn(
      `${path.basename(repoPath)}: prompt capture is off, so no agent prompt or response text is ` +
        'harvested — surfaces that show session content stay empty. Enable with `har telemetry on --prompts`.',
    );
  }

  const syncBody: Record<string, unknown> = {
    path: repoPath,
    cliVersion: getHarPackageVersion(),
    ...(status.gitRemote ? { gitRemote: status.gitRemote } : {}),
    ...(manifest ? { manifest } : {}),
    ...(stagesRegistry ? { stagesRegistry } : {}),
    slots: status.slots,
    generatedAt: status.generatedAt,
    ...(validations.length > 0
      ? {
          validations: userEmail
            ? validations.map((v) => ({ ...v, userEmail }))
            : validations,
        }
      : {}),
    ...(workUnits.length > 0 ? { workUnits } : {}),
    ...(attempts.length > 0 ? { attempts } : {}),
    ...(validationBindings.length > 0 ? { validationBindings } : {}),
    ...(usage.length > 0 ? { usage } : {}),
  };

  const runsBySource = userEmail
    ? rawRunsBySource.map(({ source, runs: sourceRuns }) => ({
        source,
        runs: sourceRuns.map((run) => ({ ...run, userEmail })),
      }))
    : rawRunsBySource;

  return {
    syncBody,
    runs: mergeRunsBySource(runsBySource),
    runsBySource,
    events,
    maxSyncedAt,
    failures,
    truncated,
  };
}

export async function isControlApiReachable(apiUrl = getControlApiUrl()): Promise<boolean> {
  try {
    const response = await fetch(`${apiUrl}/api/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function waitForControlApi(
  apiUrl = getControlApiUrl(),
  timeoutMs = 60_000,
  intervalMs = 1000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isControlApiReachable(apiUrl)) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

/**
 * Every har repo known locally: the control registry (`~/.har/repos.json`) plus
 * an optional cwd — both manifest-gated and canonicalized. Detection is registry
 * only; it neither scans the filesystem nor depends on portal/control API state.
 * Shared by the all-repos auto-sync and the interactive `har control sync`
 * selection.
 */
export async function discoverHarRepos(options?: {
  apiUrl?: string;
  cwd?: string;
}): Promise<string[]> {
  const repoPaths = new Set<string>(listRegisteredRepos());

  if (options?.cwd) {
    const cwd = canonicalizeControlRepoPath(options.cwd);
    if (readManifest(cwd)) repoPaths.add(cwd);
  }

  return [...repoPaths];
}

/**
 * Push a specific set of repos, one per timeout-guarded call. Returns the
 * summary counts plus a per-repo result so callers can print outcomes.
 */
export async function syncReposWithControl(options: {
  repoPaths: string[];
  apiUrl?: string;
  dryRun?: boolean;
  cloud?: boolean;
  full?: boolean;
  portalTargets?: string[];
}): Promise<{
  synced: number;
  failed: number;
  incomplete: number;
  results: SyncRepoResult[];
}> {
  const apiUrl = options.apiUrl ?? getControlApiUrl();
  const results: SyncRepoResult[] = [];
  let synced = 0;
  let failed = 0;
  let incomplete = 0;

  for (const repoPath of options.repoPaths) {
    const destinationAliases = destinationAliasesForSync(repoPath, options.portalTargets);
    if (destinationAliases.length > 1) {
      const targetResults: Array<{
        alias: string;
        ok: boolean;
        error?: string;
        warnings?: string[];
      }> = [];
      for (const alias of destinationAliases) {
        try {
          const outcome = await withTimeout(
            syncRepoWithControl({
              repoPath,
              apiUrl,
              dryRun: options.dryRun,
              cloud: options.cloud,
              full: options.full,
              portalTargets: [alias],
            }),
            EXPLICIT_SYNC_TIMEOUT_MS,
            'control sync',
          );
          targetResults.push({
            alias,
            ok: true,
            ...(outcome.warnings.length > 0 ? { warnings: outcome.warnings } : {}),
          });
        } catch (err: unknown) {
          targetResults.push({
            alias,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      const ok = targetResults.every((entry) => entry.ok);
      if (ok) synced++;
      else failed++;
      if (ok && targetResults.some((entry) => entry.warnings)) incomplete++;
      results.push({ repoPath, ok, targets: targetResults, error: ok ? undefined : 'one or more targets failed' });
      continue;
    }

    try {
      const outcome = await withTimeout(
        syncRepoWithControl({
          repoPath,
          apiUrl,
          dryRun: options.dryRun,
          cloud: options.cloud,
          full: options.full,
          portalTargets: options.portalTargets,
        }),
        EXPLICIT_SYNC_TIMEOUT_MS,
        'control sync',
      );
      synced++;
      if (outcome.warnings.length > 0) incomplete++;
      results.push({
        repoPath,
        ok: true,
        ...(outcome.warnings.length > 0 ? { warnings: outcome.warnings } : {}),
      });
    } catch (err: unknown) {
      failed++;
      results.push({ repoPath, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { synced, failed, incomplete, results };
}

function destinationAliasesForSync(repoPath: string, explicit?: string[]): string[] {
  if (explicit && explicit.length > 0) return explicit;
  const resolved = resolvePortalTargetsForRepo({ repoPath });
  return (resolved?.targets ?? [])
    .map((target) => target.alias)
    .filter((alias): alias is string => Boolean(alias));
}

export async function syncAllKnownReposWithControl(options?: {
  apiUrl?: string;
  cwd?: string;
}): Promise<{ synced: number; failed: number }> {
  if (!isControlEnabled()) return { synced: 0, failed: 0 };

  const apiUrl = options?.apiUrl ?? getControlApiUrl();
  if (!(await isControlApiReachable(apiUrl))) {
    return { synced: 0, failed: 0 };
  }

  const repoPaths = await discoverHarRepos({ apiUrl, cwd: options?.cwd });
  const { synced, failed } = await syncReposWithControl({ repoPaths, apiUrl });
  return { synced, failed };
}

export async function registerRepoWithControl(
  options: ControlRegisterOptions,
): Promise<{ id: string } | null> {
  const repoPath = canonicalizeControlRepoPath(options.repoPath);
  const apiUrl = options.apiUrl ?? getControlApiUrl();
  const manifest = readManifest(repoPath);
  const stagesRegistry = readStageRegistry(repoPath);

  const body: RegisterRepoInput = {
    path: repoPath,
    gitRemote: options.gitRemote,
    manifest: manifest ?? undefined,
    stagesRegistry: stagesRegistry ?? undefined,
    force: options.force,
  };

  if (options.dryRun) return null;

  const response = await fetch(`${apiUrl}/api/repos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (response.status === 409) {
    // Previously unregistered — drop from local registry so auto-sync stops retrying.
    removeRegisteredRepo(repoPath);
    return null;
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Control API ${response.status}: ${text || response.statusText}`);
  }

  return (await response.json()) as { id: string };
}

/**
 * Best-effort: record the repo in the local registry and register it with
 * Mission Control immediately, so OTLP ingest (otel-hook) can resolve
 * workspace → repo/slot without waiting for the next `har control sync` or
 * `har env launch`. Never throws — callers run this alongside telemetry
 * enablement, which must not fail just because registration did.
 */
export async function ensureRepoRegisteredWithControl(
  repoPath: string,
  apiUrl?: string,
): Promise<void> {
  const canonical = canonicalizeControlRepoPath(repoPath);
  recordRepoForControlSync(canonical);
  try {
    await registerRepoWithControl({ repoPath: canonical, apiUrl });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[har control] repo registration skipped: ${message}\n`);
  }
}

async function syncRepoWithLocalControl(
  options: ControlSyncOptions & { repoPath: string; workspacePath?: string },
): Promise<void> {
  const apiUrl = options.apiUrl ?? getControlApiUrl();
  const { repoPath, workspacePath, dryRun, full } = options;

  const registerResult = await registerRepoWithControl({ ...options, repoPath });
  const repoId = registerResult?.id;

  if (!repoId && !dryRun) {
    const listResponse = await fetch(`${apiUrl}/api/repos`);
    if (!listResponse.ok) throw new Error('Failed to list repos from Control API');
    const repos = (await listResponse.json()) as { id: string; path: string }[];
    const existing = repos.find((r) => path.resolve(r.path) === repoPath);
    if (!existing) {
      // Unregistered / blocked — nothing to sync locally.
      return;
    }
    await syncRepoRunsAndSlots(apiUrl, existing.id, repoPath, workspacePath, dryRun, full);
    return;
  }

  if (repoId) {
    await syncRepoRunsAndSlots(apiUrl, repoId, repoPath, workspacePath, dryRun, full);
  }
}

async function syncRepoWithPortal(
  options: ControlSyncOptions & { repoPath: string; workspacePath?: string },
  controlApiUrl: string,
  portal: PortalTarget,
): Promise<string[]> {
  if (!isRepoPortalSyncEnabled(options.repoPath)) return [];

  const { repoPath, workspacePath, dryRun, full } = options;
  const sourcePaths = resolveSyncSourcePaths(repoPath, workspacePath);
  const watermarkKey = watermarkKeyForTarget(portal);
  const since = full ? null : readPortalWatermarkForTarget(repoPath, portal);

  const runsTarget = runsWatermarkTargetForPortal(portal);
  let stored = full ? null : readRunsWatermarkEntry(repoPath, runsTarget);
  if (!stored && !full) {
    for (const legacyKey of legacyScopedWatermarkKeys(portal, 'runs')) {
      stored = readRunsWatermarkEntry(repoPath, legacyKey);
      if (stored) break;
    }
  }
  const runsSince = rewindSince(stored?.lastSyncedAt ?? null);
  const { syncBody, runsBySource, events, maxSyncedAt, failures, truncated } =
    await buildPortalPayload(repoPath, sourcePaths, controlApiUrl, since, full, portal);
  const newRuns = selectRunsForSync(
    runsBySource,
    runsSince,
    coveredSources(repoPath, stored),
    (rows, rowsSince) => selectSince(rows, rowsSince, runTimestamp).selected,
  );

  let repoId: string | undefined;
  const deltaRepoId = () => stored?.repoId ?? repoId;
  await syncRunBatches(
    newRuns,
    repoPath,
    runsTarget,
    deltaRepoId,
    dryRun,
    async (batch, i) => {
      const body = i === 0 ? { ...syncBody, runs: batch } : { path: repoPath, runs: batch };
      const res = await postPortal(portal, '/api/sync', body, dryRun);
      if (i === 0 && typeof res?.repositoryId === 'string') repoId = res.repositoryId;
    },
    sourcePaths,
  );

  if (!full && !dryRun && stored?.repoId && repoId && stored.repoId !== repoId) {
    await syncRunBatches(
      mergeRunsBySource(runsBySource),
      repoPath,
      runsTarget,
      () => repoId,
      dryRun,
      async (batch) => {
        await postPortal(portal, '/api/sync', { path: repoPath, runs: batch }, dryRun);
      },
      sourcePaths,
    );
  }

  for (const batch of chunkBySerializedSize(events, maxSyncBatchBytes())) {
    await postPortal(portal, '/api/otel', { path: repoPath, events: batch }, dryRun);
  }
  // Usage and events share one watermark: advancing it on one channel's rows
  // strands the other's for good when its read failed.
  if (!dryRun && maxSyncedAt && failures.length === 0) {
    writePortalWatermark(repoPath, watermarkKey, maxSyncedAt);
  }

  const warnings: string[] = [];
  if (failures.length > 0) warnings.push(describeReadFailures(repoPath, failures));
  if (truncated.length > 0) warnings.push(describeTruncatedReads(repoPath, truncated));

  warnings.push(
    ...(await syncTrajectoryWithPortal(portal, repoPath, controlApiUrl, dryRun, full)),
  );
  for (const message of warnings) warn(message);
  return warnings;
}

async function syncTrajectoryWithPortal(
  portal: PortalTarget,
  repoPath: string,
  controlApiUrl: string,
  dryRun: boolean | undefined,
  full: boolean | undefined,
): Promise<string[]> {
  const wantRecords = isPortalTrajectoryEnabledForTarget(portal);
  const wantSpans = isTelemetryEnabled();
  if (!wantRecords && !wantSpans) return [];

  const recordsTarget = trajectoryWatermarkTarget(portal);
  const spansTarget = spansWatermarkTarget(portal);
  const { records, spans, recordsMaxSyncedAt, spansMaxSyncedAt, failures, truncated } =
    await fetchPersistedTrajectory(repoPath, controlApiUrl, {
      records: wantRecords
        ? {
            since: full
              ? null
              : readScopedPortalWatermark(
                  repoPath,
                  recordsTarget,
                  legacyScopedWatermarkKeys(portal, 'trajectory'),
                ),
          }
        : false,
      spans: wantSpans
        ? {
            since: full
              ? null
              : readScopedPortalWatermark(
                  repoPath,
                  spansTarget,
                  legacyScopedWatermarkKeys(portal, 'spans'),
                ),
          }
        : false,
    });

  const failedChannel = (channel: string) =>
    failures.some((failure) => failure.channel === channel || failure.channel === 'repos');

  for (const batch of chunkBySerializedSize(spans, maxSyncBatchBytes())) {
    await postPortal(portal, '/api/otel', { path: repoPath, spans: batch }, dryRun);
  }
  if (!dryRun && spansMaxSyncedAt && !failedChannel('spans')) {
    writePortalWatermark(repoPath, spansTarget, spansMaxSyncedAt);
  }

  let recordsLanded = true;
  for (const batch of chunkBySerializedSize(records, maxSyncBatchBytes())) {
    const supported = await postPortalIfSupported(
      portal,
      '/api/trajectory',
      { path: repoPath, records: batch },
      dryRun,
    );
    if (!supported) {
      recordsLanded = false;
      warn(
        `${path.basename(repoPath)}: this har-portal has no /api/trajectory endpoint — ` +
          'trajectory forwarding skipped (upgrade the portal; records are kept for the next sync).',
      );
      break;
    }
  }
  if (!dryRun && recordsLanded && recordsMaxSyncedAt && !failedChannel('trajectory')) {
    writePortalWatermark(repoPath, recordsTarget, recordsMaxSyncedAt);
  }

  return [
    ...(failures.length > 0 ? [describeReadFailures(repoPath, failures)] : []),
    ...(truncated.length > 0 ? [describeTruncatedReads(repoPath, truncated)] : []),
  ];
}

export async function syncRepoWithControl(
  options: ControlSyncOptions,
): Promise<{ warnings: string[] }> {
  // Identity is canonical; evidence may live in the workspace this ran in (#255).
  const workspacePath = path.resolve(options.repoPath);
  const repoPath = canonicalizeControlRepoPath(options.repoPath);
  const apiUrl = options.apiUrl ?? getControlApiUrl();

  if (options.cloud) {
    const remote = createRemoteExecutor();
    if (!remote) {
      throw new Error('HAR Cloud not configured (set HAR_CLOUD_API_URL and HAR_CLOUD_API_KEY)');
    }
    const sourcePaths = resolveSyncSourcePaths(repoPath, workspacePath);
    const runs = collectRunsForSync(sourcePaths);
    const status = collectEnvironmentStatus(repoPath);
    const cloudWork = collectWorkUnitsForSync(sourcePaths);
    const harnessRoot = resolveHarnessRoot(repoPath);
    const response = await fetch(`${process.env.HAR_CLOUD_API_URL}/api/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.HAR_CLOUD_API_KEY}`,
      },
      body: JSON.stringify({
        path: repoPath,
        runs,
        slots: status.slots,
        workUnits: cloudWork.workUnits,
        attempts: cloudWork.attempts,
        validations: listValidations(harnessRoot),
        validationBindings: listValidationBindings(harnessRoot),
      }),
    });
    if (!response.ok) {
      throw new Error(`Cloud sync failed: ${response.status}`);
    }
    return { warnings: [] };
  }

  await syncRepoWithLocalControl({ ...options, repoPath, workspacePath, apiUrl });

  if (!isRepoPortalSyncEnabled(repoPath)) return { warnings: [] };

  const resolved = resolvePortalTargetsForRepo({
    repoPath,
    explicitTargets: options.portalTargets,
  });
  if (!resolved) return { warnings: [] };

  const warnings: string[] = [];
  const failures: Array<{ alias: string; error: string }> = [];
  for (const portal of resolved.targets) {
    try {
      warnings.push(
        ...(await syncRepoWithPortal({ ...options, repoPath, workspacePath }, apiUrl, portal)),
      );
    } catch (err: unknown) {
      failures.push({
        alias: portal.alias ?? portal.identityKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (failures.length === 0) return { warnings };
  if (failures.length === resolved.targets.length && failures.length === 1) {
    throw new Error(failures[0].error);
  }
  const detail = failures.map((entry) => `${entry.alias}: ${entry.error}`).join('; ');
  throw new Error(`Portal sync failed for ${failures.length} destination(s): ${detail}`);
}

async function syncRepoRunsAndSlots(
  apiUrl: string,
  repoId: string,
  repoPath: string,
  workspacePath?: string,
  dryRun?: boolean,
  full?: boolean,
): Promise<void> {
  const sourcePaths = resolveSyncSourcePaths(repoPath, workspacePath);
  const runsTarget = runsWatermarkTarget(apiUrl);
  const stored = full ? null : readRunsWatermarkEntry(repoPath, runsTarget);
  const runsSince = rewindSince(stored?.repoId === repoId ? (stored?.lastSyncedAt ?? null) : null);
  const newRuns = selectRunsForSync(
    collectRunsBySource(sourcePaths),
    runsSince,
    coveredSources(repoPath, stored),
    (rows, since) => selectSince(rows, since, runTimestamp).selected,
  );

  await syncRunBatches(
    newRuns,
    repoPath,
    runsTarget,
    () => repoId,
    dryRun,
    async (batch) => {
      await postJson(`${apiUrl}/api/repos/${repoId}/runs`, SyncRunsInputSchema.parse({ runs: batch }), dryRun);
    },
    sourcePaths,
  );

  const status: EnvironmentStatus = collectEnvironmentStatus(repoPath);
  const slotsBody = SyncSlotsInputSchema.parse({
    slots: status.slots,
    generatedAt: status.generatedAt,
  });
  await postJson(`${apiUrl}/api/repos/${repoId}/slots`, slotsBody, dryRun);

  const workUnitsBody = SyncWorkUnitsInputSchema.parse(collectWorkUnitsForSync(sourcePaths));
  if (workUnitsBody.workUnits.length > 0 || workUnitsBody.attempts.length > 0) {
    await postJson(`${apiUrl}/api/repos/${repoId}/work-units`, workUnitsBody, dryRun);
  }

  if (isTelemetryEnabled() && process.env.NODE_ENV !== 'test') {
    try {
      const userEmail = resolvePortalUserEmail();
      const usage = status.slots.flatMap((slot) =>
        harvestUsageForSlot({
          agentId: slot.agentId,
          workDir: slot.workDir,
          worktreePath: slot.worktreePath,
          branch: slot.branch,
          suffix: slot.suffix,
          sessionCreatedAt: slot.sessionCreatedAt,
          repoPath,
        }).map((row) => ({
          ...row,
          workUnitId: slot.workUnitId,
          attemptId: slot.attemptId,
          sessionKey:
            row.sessionKey ||
            buildSessionKey({
              branch: slot.branch,
              agentId: slot.agentId,
              suffix: slot.suffix,
              createdAt: slot.sessionCreatedAt,
            }),
          ...(userEmail ? { userEmail } : {}),
        })),
      );
      if (usage.length > 0) {
        const usageBody = SyncUsageInputSchema.parse({ usage });
        await postJson(`${apiUrl}/api/repos/${repoId}/usage`, usageBody, dryRun);
      }

      const events = status.slots.flatMap((slot) =>
        harvestEventsForSlot({
          agentId: slot.agentId,
          workDir: slot.workDir,
          worktreePath: slot.worktreePath,
          branch: slot.branch,
          suffix: slot.suffix,
          sessionCreatedAt: slot.sessionCreatedAt,
          repoPath,
        }).map((event) => ({
          ...event,
          workUnitId: slot.workUnitId,
          attemptId: slot.attemptId,
        })),
      );
      if (events.length > 0) {
        const eventsBody = SyncSessionEventsInputSchema.parse({ events });
        await postJson(`${apiUrl}/api/repos/${repoId}/events`, eventsBody, dryRun);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[har control] usage harvest skipped: ${message}\n`);
    }
  }

  const validations = listValidations(resolveHarnessRoot(repoPath));
  if (validations.length > 0) {
    const validationsBody = SyncValidationsInputSchema.parse({ validations });
    await postJson(`${apiUrl}/api/repos/${repoId}/validations`, validationsBody, dryRun);
  }

  const bindingsBody = SyncValidationBindingsInputSchema.parse({
    bindings: listValidationBindings(resolveHarnessRoot(repoPath)),
  });
  if (bindingsBody.bindings.length > 0) {
    await postJson(
      `${apiUrl}/api/repos/${repoId}/validation-bindings`,
      bindingsBody,
      dryRun,
    );
  }
}

const SYNC_TIMEOUT_MS = 15_000;
const EXPLICIT_SYNC_TIMEOUT_MS = 120_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Best-effort sync after harness operations. Never rejects.
 *
 * Callers MUST await this before returning control to the CLI: commands call
 * process.exit() as soon as their work resolves, which kills any still-pending
 * fetch — a fire-and-forget sync is silently dropped.
 */
export async function syncRepoWithControlAsync(repoPath: string): Promise<void> {
  if (process.env.HAR_CONTROL_DISABLED === 'true' || process.env.NODE_ENV === 'test') return;

  const verbose = process.env.HAR_CONTROL_VERBOSE === 'true';
  try {
    recordRepoForControlSync(repoPath);

    const apiUrl = getControlApiUrl();
    if (!(await isControlApiReachable(apiUrl))) {
      if (verbose) {
        process.stderr.write(`[har control] sync skipped: not reachable at ${apiUrl}\n`);
      }
      return;
    }
    const canonical = canonicalizeControlRepoPath(repoPath);
    await withTimeout(
      syncRepoWithControl({ repoPath: canonical }),
      SYNC_TIMEOUT_MS,
      'control sync',
    );
  } catch (err: unknown) {
    if (verbose) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[har control] sync skipped: ${message}\n`);
    }
  }
}

async function syncRunWithLocalControl(
  repoPath: string,
  run: RunRecord,
  apiUrl: string,
): Promise<void> {
  const registerResult = await registerRepoWithControl({ repoPath, apiUrl });
  let repoId = registerResult?.id;

  if (!repoId) {
    const listResponse = await fetch(`${apiUrl}/api/repos`);
    if (!listResponse.ok) return;
    const repos = (await listResponse.json()) as { id: string; path: string }[];
    repoId = repos.find((r) => path.resolve(r.path) === repoPath)?.id;
  }

  if (!repoId) return;

  const runsBody = SyncRunsInputSchema.parse({ runs: [run] });
  await postJson(`${apiUrl}/api/repos/${repoId}/runs`, runsBody);
}

export async function syncRunWithControlAsync(repoPath: string, run: RunRecord): Promise<void> {
  if (process.env.HAR_CONTROL_DISABLED === 'true') return;

  const apiUrl = getControlApiUrl();
  const canonical = canonicalizeControlRepoPath(repoPath);

  try {
    if (await isControlApiReachable(apiUrl)) {
      await syncRunWithLocalControl(canonical, run, apiUrl);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[har control] run sync skipped: ${message}\n`);
  }

  const resolved = resolvePortalTargetsForRepo({ repoPath: canonical });
  if (!resolved) return;
  if (!isRepoPortalSyncEnabled(canonical)) return;

  for (const portal of resolved.targets) {
    try {
      if (!(await isControlApiReachable(portal.url))) continue;
      await postPortal(portal, '/api/sync', { path: canonical, runs: [run] });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[har control] run sync skipped: ${message}\n`);
    }
  }
}
