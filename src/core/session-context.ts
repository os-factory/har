import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  SESSION_CONTEXT_ATTEMPT_ATTR,
  SESSION_CONTEXT_DIR,
  SESSION_CONTEXT_VERSION,
  SessionContextSchema,
  segmentInForce,
  sessionContextAttributeProblems,
  sessionContextRelativePath,
  type FactoryRunSessionRef,
  type SessionContext,
  type SessionSegment,
} from '../harness/schema';
import { readGitRemote, sanitizeGitRemoteUrl } from './git-remote';
import { currentAgentSession, type InnermostAgentResolver } from './session-bindings';
import { findWorkAttempt, findWorkUnit, markWorkAttemptEnded, workAttemptEndLookup } from './work-units';

/**
 * Session context files (ADR 0004 section 2): the CLI is their only writer.
 *
 * `har env launch` opens a segment for the agent session that ran it (closing
 * that session's open segment first). `teardown` / `complete` close every open
 * segment of the ending attempt, in every session file, whoever runs them. A
 * segment whose attempt has ended counts as closed for every reader even while
 * its `to` is still empty; every write here repairs such segments first.
 *
 * Files live at `~/.har/sessions/<agent-tool>/<session-id>.json`, mode 0600,
 * written atomically (temp file + rename).
 */

/** Attribute keys a segment carries (telemetry profile + OTel semconv). Never paths. */
export const SEGMENT_ATTR = {
  workUnitId: 'factory.work_unit.id',
  workUnitSource: 'factory.work_unit.source',
  attemptId: SESSION_CONTEXT_ATTEMPT_ATTR,
  slotId: 'factory.slot.id',
  repositoryUrl: 'vcs.repository.url.full',
  branch: 'vcs.ref.head.name',
} as const;

export interface AgentSessionRef {
  agentTool: string;
  sessionId: string;
}

/** End time of an attempt that has ended, else undefined. */
export type AttemptEndLookup = (attemptId: string) => string | undefined;

const noAttemptEnded: AttemptEndLookup = () => undefined;

/** Overrides the session context directory (tests, sandboxes). Readers must be pointed at the same place. */
export const SESSION_CONTEXT_DIR_ENV = 'HAR_SESSIONS_DIR';

/** `~/.har/sessions`, or `$HAR_SESSIONS_DIR` when set; an explicit `home` wins over both. */
export function sessionContextRoot(home?: string): string {
  if (home) return path.join(home, SESSION_CONTEXT_DIR);
  const override = process.env[SESSION_CONTEXT_DIR_ENV]?.trim();
  if (override) return path.resolve(override);
  return path.join(os.homedir(), SESSION_CONTEXT_DIR);
}

/** Path of a session's context file, or undefined when the ids are not safe path segments. */
export function sessionContextFile(agent: AgentSessionRef, home?: string): string | undefined {
  try {
    return path.join(sessionContextRoot(home), sessionContextRelativePath(agent.agentTool, agent.sessionId));
  } catch {
    return undefined;
  }
}

export function readSessionContextFile(file: string): SessionContext | undefined {
  try {
    const parsed = SessionContextSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export interface SessionContextEntry {
  file: string;
  context: SessionContext;
}

/** Every readable session context file on this machine. Unreadable or invalid files are skipped. */
export function listSessionContexts(home?: string): SessionContextEntry[] {
  const root = sessionContextRoot(home);
  let tools: fs.Dirent[];
  try {
    tools = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: SessionContextEntry[] = [];
  for (const tool of tools) {
    if (!tool.isDirectory()) continue;
    const dir = path.join(root, tool.name);
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(dir, name);
      const context = readSessionContextFile(file);
      if (context) out.push({ file, context });
    }
  }
  return out;
}

/** Atomic write (temp file + rename), file mode 0600, directories 0700. */
export function writeSessionContextFile(file: string, context: SessionContext): void {
  const parsed = SessionContextSchema.parse(context);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(temp, 0o600);
    fs.renameSync(temp, file);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
}

function laterOf(a: string, b: string): string {
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

/**
 * Set `to` on open segments whose attempt has ended: the attempt's end time
 * (never before the segment's `from`). Returns a new context when anything
 * changed, else undefined.
 */
export function repairEndedSegments(
  context: SessionContext,
  attemptEndedAt: AttemptEndLookup,
): SessionContext | undefined {
  let changed = false;
  const segments = context.segments.map((segment) => {
    if (segment.to !== null) return segment;
    const attemptId = segment.attributes[SEGMENT_ATTR.attemptId];
    const endedAt = attemptId ? attemptEndedAt(attemptId) : undefined;
    if (!endedAt || Number.isNaN(Date.parse(endedAt))) return segment;
    changed = true;
    return { ...segment, to: laterOf(segment.from, new Date(endedAt).toISOString()) };
  });
  return changed ? { ...context, segments } : undefined;
}

/** Repair every session file on this machine (see {@link repairEndedSegments}). */
export function repairAllSessionContexts(attemptEndedAt: AttemptEndLookup, home?: string): number {
  let repaired = 0;
  for (const entry of listSessionContexts(home)) {
    const fixed = repairEndedSegments(entry.context, attemptEndedAt);
    if (!fixed) continue;
    try {
      writeSessionContextFile(entry.file, fixed);
      repaired += 1;
    } catch {
      // Best effort: readers already treat these segments as closed.
    }
  }
  return repaired;
}

/**
 * Which slot occupancy a segment belongs to. With an attempt, the attempt id
 * decides alone. A slot launched without a work unit has no attempt; its
 * segments are matched by slot id, branch and repository, and only segments
 * that carry no attempt id match.
 */
export interface SegmentOccupancy {
  attemptId?: string;
  slotId: string;
  branch?: string;
  repositoryUrl?: string;
}

export function segmentBelongsTo(segment: SessionSegment, occupancy: SegmentOccupancy): boolean {
  const attemptId = segment.attributes[SEGMENT_ATTR.attemptId];
  if (occupancy.attemptId) return attemptId === occupancy.attemptId;
  if (attemptId) return false;
  return (
    segment.attributes[SEGMENT_ATTR.slotId] === occupancy.slotId &&
    (segment.attributes[SEGMENT_ATTR.branch] ?? undefined) === occupancy.branch &&
    (segment.attributes[SEGMENT_ATTR.repositoryUrl] ?? undefined) === occupancy.repositoryUrl
  );
}

/**
 * The attribute map of a new segment: only telemetry-profile and semconv keys,
 * empty values dropped, and anything a session context must not hold (paths)
 * removed rather than written.
 */
export function buildSegmentAttributes(input: {
  workUnitId?: string;
  workUnitSource?: string;
  attemptId?: string;
  slotId: number | string;
  repositoryUrl?: string;
  branch?: string;
}): Record<string, string> {
  const candidates: Array<[string, string | undefined]> = [
    [SEGMENT_ATTR.workUnitId, input.workUnitId],
    [SEGMENT_ATTR.workUnitSource, input.workUnitSource],
    [SEGMENT_ATTR.attemptId, input.attemptId],
    [SEGMENT_ATTR.slotId, String(input.slotId)],
    [SEGMENT_ATTR.repositoryUrl, input.repositoryUrl],
    [SEGMENT_ATTR.branch, input.branch],
  ];
  const attributes: Record<string, string> = {};
  for (const [key, value] of candidates) {
    const trimmed = value?.trim();
    if (!trimmed) continue;
    if (sessionContextAttributeProblems({ [key]: trimmed }).length > 0) continue;
    attributes[key] = trimmed;
  }
  return attributes;
}

export interface OpenSegmentInput {
  agent: AgentSessionRef;
  attributes: Record<string, string>;
  /** ISO timestamp; defaults to now. */
  at?: string;
  attemptEndedAt?: AttemptEndLookup;
  home?: string;
  /** Why the segment opens (default `launch`). */
  reason?: string;
}

/**
 * Open a segment for one agent session (`har env launch`). The session's open
 * segment, if any, is closed at the same instant. Returns the written context,
 * or undefined when the session ids cannot name a file.
 */
export function openSessionSegment(input: OpenSegmentInput): SessionContext | undefined {
  const file = sessionContextFile(input.agent, input.home);
  if (!file) return undefined;
  const ended = input.attemptEndedAt ?? noAttemptEnded;
  repairAllSessionContexts(ended, input.home);

  let at = new Date(input.at ?? Date.now()).toISOString();
  const existing = readSessionContextFile(file);
  const segments: SessionSegment[] = (existing?.segments ?? []).map((segment) => ({ ...segment }));
  const last = segments[segments.length - 1];
  if (last) {
    // Segments never overlap and stay in time order, even with a skewed clock.
    const floor = last.to ?? last.from;
    if (Date.parse(at) < Date.parse(floor)) at = new Date(floor).toISOString();
    if (last.to === null) last.to = at;
  }
  segments.push({ from: at, to: null, reason: input.reason ?? 'launch', attributes: { ...input.attributes } });

  const context: SessionContext = {
    version: SESSION_CONTEXT_VERSION,
    agentTool: input.agent.agentTool,
    sessionId: input.agent.sessionId,
    segments,
  };
  writeSessionContextFile(file, context);
  return context;
}

export interface ClosedSegment extends AgentSessionRef {
  from: string;
  to: string;
  attributes: Record<string, string>;
}

/**
 * Close every open segment of an occupancy, in every session file
 * (`teardown`, `complete`, `work-bind`). Keyed by the attempt, not by the
 * caller: a terminal with no agent session closes the agent's segments too.
 */
export function closeSegmentsForOccupancy(input: {
  occupancy: SegmentOccupancy;
  at?: string;
  attemptEndedAt?: AttemptEndLookup;
  home?: string;
}): ClosedSegment[] {
  const ended = input.attemptEndedAt ?? noAttemptEnded;
  repairAllSessionContexts(ended, input.home);
  const at = new Date(input.at ?? Date.now()).toISOString();
  const closed: ClosedSegment[] = [];
  for (const entry of listSessionContexts(input.home)) {
    let changed = false;
    const segments = entry.context.segments.map((segment) => {
      if (segment.to !== null || !segmentBelongsTo(segment, input.occupancy)) return segment;
      changed = true;
      const to = laterOf(segment.from, at);
      closed.push({
        agentTool: entry.context.agentTool,
        sessionId: entry.context.sessionId,
        from: segment.from,
        to,
        attributes: segment.attributes,
      });
      return { ...segment, to };
    });
    if (!changed) continue;
    try {
      writeSessionContextFile(entry.file, { ...entry.context, segments });
    } catch {
      // Best effort: once the attempt is marked ended, readers treat it as closed.
    }
  }
  return closed;
}

/**
 * `har env work-bind` gives a running slot a new attempt. Sessions working in
 * the slot under the old occupancy keep working there, so each gets its open
 * segment closed and a new one opened with the new attributes at the same
 * instant; the session running the bind gets a new segment too.
 */
export function rebindSessionSegments(input: {
  before: SegmentOccupancy;
  attributes: Record<string, string>;
  caller?: AgentSessionRef | null;
  at?: string;
  attemptEndedAt?: AttemptEndLookup;
  home?: string;
}): AgentSessionRef[] {
  const at = new Date(input.at ?? Date.now()).toISOString();
  const closed = closeSegmentsForOccupancy({
    occupancy: input.before,
    at,
    attemptEndedAt: input.attemptEndedAt,
    home: input.home,
  });
  const sessions = new Map<string, AgentSessionRef>();
  for (const segment of closed) sessions.set(`${segment.agentTool}\0${segment.sessionId}`, segment);
  if (input.caller) sessions.set(`${input.caller.agentTool}\0${input.caller.sessionId}`, input.caller);
  const opened: AgentSessionRef[] = [];
  for (const agent of sessions.values()) {
    const context = openSessionSegment({
      agent: { agentTool: agent.agentTool, sessionId: agent.sessionId },
      attributes: input.attributes,
      at,
      attemptEndedAt: input.attemptEndedAt,
      home: input.home,
    });
    if (context) opened.push({ agentTool: agent.agentTool, sessionId: agent.sessionId });
  }
  return opened;
}

/** The segment of a session in force now (ended attempts count as closed). */
export function openSegmentOf(
  agent: AgentSessionRef,
  options: { attemptEndedAt?: AttemptEndLookup; home?: string; at?: string } = {},
): SessionSegment | undefined {
  const file = sessionContextFile(agent, options.home);
  const context = file ? readSessionContextFile(file) : undefined;
  if (!context) return undefined;
  const ended = options.attemptEndedAt ?? noAttemptEnded;
  return segmentInForce(context, options.at ?? Date.now(), { isAttemptEnded: (id) => ended(id) !== undefined });
}

/**
 * Sessions whose segments for an occupancy overlap the run window
 * `[windowStart, windowEnd]` (ADR 0004 section 4). One ref per session: the
 * earliest overlap start and the latest overlap end (`null` while a segment
 * is still open). The session that ran the verify is flagged `ranVerify`; when
 * it has no overlapping segment (it verified without launching), it is listed
 * with the verify's own interval.
 */
export function computeSessionRefs(input: {
  occupancy: SegmentOccupancy;
  windowStart?: string;
  windowEnd: string;
  ranVerify?: AgentSessionRef | null;
  verifyStartedAt?: string;
  attemptEndedAt?: AttemptEndLookup;
  home?: string;
}): FactoryRunSessionRef[] {
  const ended = input.attemptEndedAt ?? noAttemptEnded;
  const windowEnd = Date.parse(input.windowEnd);
  const windowStart = input.windowStart ? Date.parse(input.windowStart) : Number.NEGATIVE_INFINITY;
  const refs = new Map<string, FactoryRunSessionRef>();
  const key = (agent: AgentSessionRef) => `${agent.agentTool}\0${agent.sessionId}`;

  for (const { context } of listSessionContexts(input.home)) {
    for (const segment of context.segments) {
      if (!segmentBelongsTo(segment, input.occupancy)) continue;
      const attemptId = segment.attributes[SEGMENT_ATTR.attemptId];
      const effectiveTo = segment.to ?? (attemptId ? ended(attemptId) : undefined) ?? null;
      const from = Date.parse(segment.from);
      const to = effectiveTo === null ? Number.POSITIVE_INFINITY : Date.parse(effectiveTo);
      if (from > windowEnd || to < windowStart) continue;
      const overlapFrom = new Date(Math.max(from, windowStart)).toISOString();
      const overlapTo = effectiveTo === null ? null : new Date(Math.min(to, windowEnd)).toISOString();
      const ref: FactoryRunSessionRef = {
        agentTool: context.agentTool,
        sessionId: context.sessionId,
        from: overlapFrom,
        to: overlapTo,
        ranVerify: false,
      };
      const previous = refs.get(key(ref));
      refs.set(key(ref), previous ? mergeSessionRef(previous, ref) : ref);
    }
  }

  if (input.ranVerify) {
    const existing = refs.get(key(input.ranVerify));
    if (existing) {
      existing.ranVerify = true;
    } else {
      const from = new Date(input.verifyStartedAt ?? input.windowEnd).toISOString();
      refs.set(key(input.ranVerify), {
        agentTool: input.ranVerify.agentTool,
        sessionId: input.ranVerify.sessionId,
        from,
        to: new Date(input.windowEnd).toISOString(),
        ranVerify: true,
      });
    }
  }
  return sortSessionRefs([...refs.values()]);
}

function mergeSessionRef(a: FactoryRunSessionRef, b: FactoryRunSessionRef): FactoryRunSessionRef {
  const from = Date.parse(a.from) <= Date.parse(b.from) ? a.from : b.from;
  const to = a.to === null || b.to === null ? null : laterOf(a.to, b.to);
  return { agentTool: a.agentTool, sessionId: a.sessionId, from, to, ranVerify: a.ranVerify || b.ranVerify };
}

function sortSessionRefs(refs: FactoryRunSessionRef[]): FactoryRunSessionRef[] {
  return refs.sort(
    (a, b) =>
      a.from.localeCompare(b.from) || a.agentTool.localeCompare(b.agentTool) || a.sessionId.localeCompare(b.sessionId),
  );
}

/**
 * Merge the session refs of a re-verify of the same tree into the stored list
 * (ADR 0004 section 4: merged, never replaced). Per session: the earliest
 * `from`; `to` from the newer computation when it says the session is still
 * open, else the later of both; `ranVerify` if either says so. Sessions only
 * in the stored list are kept.
 */
export function mergeSessionRefs(
  stored: readonly FactoryRunSessionRef[] | undefined,
  fresh: readonly FactoryRunSessionRef[],
): FactoryRunSessionRef[] {
  const out = new Map<string, FactoryRunSessionRef>();
  const key = (ref: FactoryRunSessionRef) => `${ref.agentTool}\0${ref.sessionId}`;
  for (const ref of stored ?? []) out.set(key(ref), { ...ref });
  for (const ref of fresh) {
    const old = out.get(key(ref));
    if (!old) {
      out.set(key(ref), { ...ref });
      continue;
    }
    out.set(key(ref), {
      agentTool: ref.agentTool,
      sessionId: ref.sessionId,
      from: Date.parse(old.from) <= Date.parse(ref.from) ? old.from : ref.from,
      to: ref.to === null ? null : old.to === null ? ref.to : laterOf(old.to, ref.to),
      ranVerify: old.ranVerify || ref.ranVerify,
    });
  }
  return sortSessionRefs([...out.values()]);
}

// ---------------------------------------------------------------------------
// Slot lifecycle glue (launch, teardown/complete, work-bind, verify)
// ---------------------------------------------------------------------------

type Env = Readonly<Record<string, string | undefined>>;

interface SlotOccupancySource {
  agentId: number;
  attemptId?: string;
  workUnitId?: string;
  branch?: string;
  workDir?: string;
}

/** Credential-free `origin` URL of a checkout, or undefined (no remote, local path). */
export function repositoryUrlOf(dir: string | undefined): string | undefined {
  return dir ? sanitizeGitRemoteUrl(readGitRemote(dir)) : undefined;
}

/**
 * The repository URL of a slot: its work dir's remote, else the harness root's.
 * Teardown and complete send their records after the slot's worktree is
 * removed; the main checkout has the same remote.
 */
export function slotRepositoryUrl(workDir: string | undefined, harnessRoot: string): string | undefined {
  return repositoryUrlOf(workDir) ?? repositoryUrlOf(harnessRoot);
}

export function slotSegmentOccupancy(
  session: SlotOccupancySource,
  harnessRoot: string,
): SegmentOccupancy {
  return {
    attemptId: session.attemptId,
    slotId: String(session.agentId),
    branch: session.branch,
    repositoryUrl: slotRepositoryUrl(session.workDir, harnessRoot),
  };
}

export function slotSegmentAttributes(session: SlotOccupancySource, harnessRoot: string): Record<string, string> {
  const source = session.workUnitId ? findWorkUnit(harnessRoot, session.workUnitId)?.source : undefined;
  return buildSegmentAttributes({
    workUnitId: session.workUnitId,
    workUnitSource: source,
    attemptId: session.attemptId,
    slotId: session.agentId,
    repositoryUrl: slotRepositoryUrl(session.workDir, harnessRoot),
    branch: session.branch,
  });
}

/**
 * `har env launch` succeeded: open a segment for the agent session that ran it.
 * No agent session (or an ambiguous process tree) → no file is written.
 */
export function recordLaunchSegment(options: {
  harnessRoot: string;
  session: SlotOccupancySource;
  env?: Env;
  at?: string;
  home?: string;
  resolveInnermost?: InnermostAgentResolver;
}): SessionContext | undefined {
  const agent = currentAgentSession(options.env ?? process.env, options.resolveInnermost);
  if (!agent) return undefined;
  return openSessionSegment({
    agent,
    attributes: slotSegmentAttributes(options.session, options.harnessRoot),
    at: options.at,
    attemptEndedAt: workAttemptEndLookup(options.harnessRoot),
    home: options.home,
  });
}

/**
 * `har env work-bind` with the slot's own work unit, from an agent session that
 * does not work under the slot's attempt yet (a second agent, a resumed
 * session with a new id): open a segment for it, as launch does for the
 * session that launched. A session already working under the attempt keeps its
 * segment. Returns the joined session, or undefined when nothing changed.
 */
export function joinSlotSegment(options: {
  harnessRoot: string;
  session: SlotOccupancySource;
  env?: Env;
  at?: string;
  home?: string;
  resolveInnermost?: InnermostAgentResolver;
}): AgentSessionRef | undefined {
  const agent = currentAgentSession(options.env ?? process.env, options.resolveInnermost);
  if (!agent) return undefined;
  const occupancy = slotSegmentOccupancy(options.session, options.harnessRoot);
  const attemptEndedAt = workAttemptEndLookup(options.harnessRoot);
  const current = openSegmentOf(agent, { attemptEndedAt, home: options.home, at: options.at });
  if (current && segmentBelongsTo(current, occupancy)) return undefined;
  const context = openSessionSegment({
    agent,
    attributes: slotSegmentAttributes(options.session, options.harnessRoot),
    at: options.at,
    attemptEndedAt,
    home: options.home,
    reason: 'join',
  });
  return context ? agent : undefined;
}

/**
 * The slot occupancy ends (`teardown`, `complete`): close every open segment of
 * its attempt in every session file, THEN mark the attempt ended. A crash in
 * between leaves the segments closed and the attempt live, which readers see
 * correctly; the reverse order would leave open segments of an ended attempt
 * (still read as closed, and repaired on the next write).
 */
export function endSlotOccupancySegments(options: {
  harnessRoot: string;
  session: SlotOccupancySource;
  at?: string;
  home?: string;
}): ClosedSegment[] {
  const at = new Date(options.at ?? Date.now()).toISOString();
  const closed = closeSegmentsForOccupancy({
    occupancy: slotSegmentOccupancy(options.session, options.harnessRoot),
    at,
    attemptEndedAt: workAttemptEndLookup(options.harnessRoot),
    home: options.home,
  });
  if (options.session.attemptId) markWorkAttemptEnded(options.harnessRoot, options.session.attemptId, at);
  return closed;
}

/**
 * `har env work-bind` gave the slot a new attempt: move the sessions working in
 * it to the new attempt, then mark the old attempt ended.
 */
export function rebindSlotSegments(options: {
  harnessRoot: string;
  before: SlotOccupancySource;
  after: SlotOccupancySource;
  env?: Env;
  at?: string;
  home?: string;
  resolveInnermost?: InnermostAgentResolver;
}): AgentSessionRef[] {
  const at = new Date(options.at ?? Date.now()).toISOString();
  const opened = rebindSessionSegments({
    before: slotSegmentOccupancy(options.before, options.harnessRoot),
    attributes: slotSegmentAttributes(options.after, options.harnessRoot),
    caller: currentAgentSession(options.env ?? process.env, options.resolveInnermost),
    at,
    attemptEndedAt: workAttemptEndLookup(options.harnessRoot),
    home: options.home,
  });
  if (options.before.attemptId && options.before.attemptId !== options.after.attemptId) {
    markWorkAttemptEnded(options.harnessRoot, options.before.attemptId, at);
  }
  return opened;
}

/**
 * Session refs of a verify (ADR 0004 section 4): the sessions whose segments
 * for the slot's attempt overlap `[attempt start, run finish]`, the caller
 * flagged `ranVerify`.
 */
export function verifySessionRefs(options: {
  harnessRoot: string;
  session: SlotOccupancySource & { createdAt?: string };
  runStartedAt?: string;
  runFinishedAt: string;
  env?: Env;
  home?: string;
  resolveInnermost?: InnermostAgentResolver;
}): FactoryRunSessionRef[] {
  const attempt = options.session.attemptId
    ? findWorkAttempt(options.harnessRoot, options.session.attemptId)
    : undefined;
  return computeSessionRefs({
    occupancy: slotSegmentOccupancy(options.session, options.harnessRoot),
    windowStart: attempt?.createdAt ?? options.session.createdAt,
    windowEnd: options.runFinishedAt,
    ranVerify: currentAgentSession(options.env ?? process.env, options.resolveInnermost),
    verifyStartedAt: options.runStartedAt,
    attemptEndedAt: workAttemptEndLookup(options.harnessRoot),
    home: options.home,
  });
}
