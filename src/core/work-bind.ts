import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { resolveHarnessRoot } from '../harness/manifest';
import {
  SlotRegistryEntry,
  WorkAttemptRecord,
  WorkUnitRecord,
  WorkUnitRelatedLink,
} from '../harness/schema';
import { canonicalizeControlRepoPath } from './control-repo-path';
import { recordRebindBindings, slotOccupancyKey } from './session-bindings';
import { rebindSlotSegments } from './session-context';
import {
  listSlotRegistryEntries,
  resolveSlotRegistryContext,
  writeSlotRegistry,
} from './slot-registry';
import { appendTelemetryEnvToFile, buildSessionKey } from './telemetry-env';
import {
  createWorkAttempt,
  decideWorkUnitOutcome,
  findWorkUnit,
  upsertWorkUnit,
} from './work-units';

/**
 * Bind (or change) the work unit of a slot that is already running.
 *
 * A slot launched without `--work-id` (a panel's "New discussion", an agent
 * that only learns the ticket after reading the task) gets its unit here.
 * Mapping onto the records `launch --work-id` writes:
 *
 * - the work unit is upserted exactly as at launch (immutable fields guarded,
 *   a decided unit reopened);
 * - a NEW attempt is minted — attempts are immutable identities, so a binding
 *   never re-points one. A first binding's attempt starts at the slot's launch
 *   (it owns everything done in the occupancy so far); a rebinding's attempt
 *   starts now and the old unit keeps its own attempt and the evidence and
 *   usage recorded under it, closed as `abandoned` the way teardown closes one;
 * - the slot registry carries the new `workUnitId`/`attemptId`, which moves its
 *   occupancy key to the new attempt's; session bindings under the old key are
 *   released and reopened under the new one;
 * - the `.env.agent.<id>` attribution block is rewritten for processes started
 *   from now on. Running agents keep the env they started with; Mission Control
 *   attributes their usage through the slot record.
 *
 * Binding the unit the slot already carries is idempotent: it only merges new
 * metadata (title, URL, links) and keeps the attempt.
 */
export interface BindWorkUnitOptions {
  /** Repository (or any path inside it, worktrees included). */
  repoPath: string;
  /** Slot to bind; defaults to the slot whose work dir contains `cwd`. */
  agentId?: number;
  /** Path used to find the slot when `agentId` is omitted. Defaults to `repoPath`. */
  cwd?: string;
  workUnitId: string;
  source?: string;
  sourceUrl?: string;
  title?: string;
  parentWorkUnitId?: string;
  relatedLinks?: WorkUnitRelatedLink[];
  env?: Readonly<Record<string, string | undefined>>;
  /** Injectable clock for tests. */
  now?: string;
}

export interface BindWorkUnitResult {
  ok: true;
  agentId: number;
  workUnitId: string;
  attemptId: string;
  /** False when the slot already carried this unit (metadata merge only). */
  changed: boolean;
  previousWorkUnitId?: string;
  previousAttemptId?: string;
  workDir: string;
  branch?: string;
  workUnit: WorkUnitRecord;
  attempt?: WorkAttemptRecord;
  notices: string[];
}

export class WorkBindError extends Error {}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function realpathOr(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function candidateHarnessRoots(repoPath: string): string[] {
  const roots = [resolveHarnessRoot(repoPath)];
  const main = resolveHarnessRoot(canonicalizeControlRepoPath(repoPath));
  if (!roots.includes(main)) roots.push(main);
  return roots;
}

/**
 * The slot whose work dir (or worktree) contains `cwd`. Looks in the harness
 * that owns `repoPath` and in the main checkout's, since a session worktree
 * carries its own `.har/` while the slot registry lives in the main checkout.
 */
export function findSlotForPath(
  repoPath: string,
  cwd: string,
): { harnessRoot: string; session: SlotRegistryEntry } | undefined {
  const target = realpathOr(cwd);
  let best: { harnessRoot: string; session: SlotRegistryEntry; depth: number } | undefined;
  for (const harnessRoot of candidateHarnessRoots(repoPath)) {
    for (const session of listSlotRegistryEntries(harnessRoot)) {
      if (session.mode === 'root') continue;
      for (const dir of [session.workDir, session.worktreePath]) {
        if (!dir) continue;
        const root = realpathOr(dir);
        if (!isInside(target, root)) continue;
        const depth = root.length;
        if (!best || depth > best.depth) best = { harnessRoot, session, depth };
      }
    }
  }
  return best ? { harnessRoot: best.harnessRoot, session: best.session } : undefined;
}

function resolveTargetSlot(options: BindWorkUnitOptions): {
  harnessRoot: string;
  session: SlotRegistryEntry;
} {
  if (options.agentId !== undefined) {
    const context = resolveSlotRegistryContext(options.repoPath, options.agentId);
    if (!context) {
      throw new WorkBindError(
        `No session for agent ${options.agentId}. Launch it first: har env launch ${options.agentId}`,
      );
    }
    return context;
  }
  const cwd = options.cwd ?? options.repoPath;
  const found = findSlotForPath(options.repoPath, cwd);
  if (!found) {
    throw new WorkBindError(
      `${path.resolve(cwd)} is not inside a slot work dir. Pass the slot id: har env work-bind <id> --work-id …`,
    );
  }
  return found;
}

export function bindWorkUnit(options: BindWorkUnitOptions): BindWorkUnitResult {
  const { harnessRoot, session } = resolveTargetSlot(options);
  const agentId = session.agentId;
  if (session.status !== 'active') {
    throw new WorkBindError(
      `Slot ${agentId} is ${session.status}, not active. Finish the launch (har env recover ${agentId}) before binding work.`,
    );
  }
  const now = options.now ?? new Date().toISOString();
  const notices: string[] = [];
  const metadata = {
    workUnitId: options.workUnitId,
    source: options.source,
    sourceUrl: options.sourceUrl,
    title: options.title,
    parentWorkUnitId: options.parentWorkUnitId,
    relatedLinks: options.relatedLinks,
  };

  if (session.workUnitId === options.workUnitId && session.attemptId) {
    // Same unit: merge metadata only, keep the attempt and occupancy key.
    let workUnit: WorkUnitRecord;
    try {
      workUnit = upsertWorkUnit(harnessRoot, metadata);
    } catch (err) {
      throw new WorkBindError(err instanceof Error ? err.message : String(err));
    }
    return {
      ok: true,
      agentId,
      workUnitId: options.workUnitId,
      attemptId: session.attemptId,
      changed: false,
      workDir: session.workDir,
      branch: session.branch,
      workUnit,
      notices: [`Slot ${agentId} is already bound to work unit ${options.workUnitId}; metadata updated.`],
    };
  }

  const conflict = listSlotRegistryEntries(harnessRoot).find(
    (entry) => entry.agentId !== agentId && entry.workUnitId === options.workUnitId,
  );
  if (conflict) {
    throw new WorkBindError(
      `Work unit ${options.workUnitId} is already bound to slot ${conflict.agentId} (attempt ${conflict.attemptId ?? 'unknown'}).`,
    );
  }

  // Validate and write the new unit first: an immutable-field clash must leave
  // the slot and the old unit untouched.
  const priorOutcome = findWorkUnit(harnessRoot, options.workUnitId)?.outcome;
  let workUnit: WorkUnitRecord;
  try {
    workUnit = upsertWorkUnit(harnessRoot, metadata);
  } catch (err) {
    throw new WorkBindError(err instanceof Error ? err.message : String(err));
  }
  if (priorOutcome) {
    const reason = priorOutcome.reason ? `: ${priorOutcome.reason}` : '';
    notices.push(
      `Reopened work unit ${options.workUnitId} (${priorOutcome.decision} ${priorOutcome.decidedAt}${reason})`,
    );
  }

  const previousWorkUnitId = session.workUnitId;
  const previousAttemptId = session.attemptId;
  if (previousWorkUnitId && previousWorkUnitId !== options.workUnitId) {
    const previous = findWorkUnit(harnessRoot, previousWorkUnitId);
    if (previous && !previous.outcome) {
      decideWorkUnitOutcome(harnessRoot, previousWorkUnitId, {
        decision: 'abandoned',
        decidedAt: now,
        attemptId: previousAttemptId,
        reason: `Slot ${agentId} rebound to work unit ${options.workUnitId}.`,
      });
    }
    notices.push(
      `Work unit ${previousWorkUnitId} keeps attempt ${previousAttemptId ?? 'unknown'} and the evidence recorded under it; slot ${agentId} now works on ${options.workUnitId}.`,
    );
  }

  const attemptId = crypto.randomUUID();
  const after: SlotRegistryEntry = { ...session, workUnitId: options.workUnitId, attemptId };
  const sessionKey = buildSessionKey({
    branch: session.branch,
    agentId,
    suffix: session.suffix,
    createdAt: session.createdAt,
  });
  const attempt = createWorkAttempt(harnessRoot, {
    attemptId,
    workUnitId: options.workUnitId,
    agentId,
    sessionKey,
    workDir: session.workDir,
    worktreePath: session.worktreePath,
    branch: session.branch,
    baseCommit: session.baseCommit,
    // A first binding owns the occupancy since launch; a rebinding starts now.
    createdAt: previousAttemptId ? now : session.createdAt,
    boundAt: now,
    previousAttemptId,
    previousOccupancyKey: slotOccupancyKey(session),
  });

  writeSlotRegistry(harnessRoot, {
    agentId,
    projectName: session.projectName,
    mode: session.mode,
    workDir: session.workDir,
    status: session.status,
    suffix: session.suffix,
    worktreePath: session.worktreePath,
    branch: session.branch,
    baseBranch: session.baseBranch,
    baseCommit: session.baseCommit,
    lastError: session.lastError,
    workUnitId: options.workUnitId,
    attemptId,
    ports: session.ports,
    previewUrls: session.previewUrls,
    createdAt: session.createdAt,
  });

  try {
    recordRebindBindings({
      harnessRoot,
      before: session,
      after,
      env: options.env ?? process.env,
      at: now,
    });
  } catch {
    // Attribution evidence is best-effort; the binding itself succeeded.
  }
  try {
    // ADR 0004 §2: sessions in the slot move to the new attempt; the old one ends.
    rebindSlotSegments({ harnessRoot, before: session, after, env: options.env ?? process.env, at: now });
  } catch {
    // Session context is best-effort; the binding itself succeeded.
  }

  const envFile = path.join(session.workDir, `.env.agent.${agentId}`);
  if (fs.existsSync(envFile)) {
    try {
      appendTelemetryEnvToFile(envFile, {
        sessionKey,
        agentId,
        repoPath: harnessRoot,
        workDir: session.workDir,
        branch: session.branch,
        suffix: session.suffix,
        workUnitId: options.workUnitId,
        attemptId,
      });
    } catch {
      // Env injection is best-effort, as at launch.
    }
  }

  return {
    ok: true,
    agentId,
    workUnitId: options.workUnitId,
    attemptId,
    changed: true,
    ...(previousWorkUnitId ? { previousWorkUnitId } : {}),
    ...(previousAttemptId ? { previousAttemptId } : {}),
    workDir: session.workDir,
    branch: session.branch,
    workUnit,
    attempt,
    notices,
  };
}
