import { z } from 'zod';
import { LOCAL_ATTR_PREFIX } from './session-attribution';

/**
 * Session context file (ADR 0004 section 2), version 1.
 *
 * One file per agent session, on the machine running the agent:
 * `~/.har/sessions/<agent-tool>/<session-id>.json` (mode 0600, written
 * atomically). The HAR CLI is its only writer; emitters (otel-hook) read it and
 * stamp the attributes of the segment in force onto every record they emit.
 *
 * A segment says which work identity a session worked under, from `from` until
 * `to` (`null` while open). `attributes` holds only Factory Commits telemetry
 * profile and OTel semconv attributes: never paths, prompts or secrets.
 *
 * This is a format other tools read, fixed before HAR 2.0.0: add fields only
 * in a new `version`.
 */

export const SESSION_CONTEXT_VERSION = 1 as const;

/** Directory under the user's home that holds the session context files. */
export const SESSION_CONTEXT_DIR = '.har/sessions';

/**
 * Agent tool and session id are path segments of the context file, so both are
 * restricted to characters that cannot escape the directory. HAR writes
 * `claude_code`, `codex` and `cursor` (see `AgentToolSchema`); other harnesses may
 * write other tools.
 */
export const SessionContextAgentToolSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
export const SessionContextSessionIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/)
  .refine((id) => !id.includes('..'), { message: 'session id must not contain ".."' });

/** Why a segment was opened. HAR 2.0 writes `launch`; readers accept any non-empty token. */
export const SESSION_SEGMENT_REASONS = ['launch'] as const;
export type SessionSegmentReason = (typeof SESSION_SEGMENT_REASONS)[number];

/** Attribute key prefixes a session context must never hold (local paths). */
export const SESSION_CONTEXT_FORBIDDEN_ATTR_PREFIXES = [LOCAL_ATTR_PREFIX] as const;

/** A value that is an absolute local path: `/…`, `~/…`, `C:\…` / `C:/…`, `\\server\…`. */
const ABSOLUTE_PATH_VALUE = /^(?:\/|~(?:\/|$)|[A-Za-z]:[\\/]|\\\\)/;

/**
 * Why an attribute map is not allowed in a session context, one message per
 * offending key; empty when it is fine. Keys under `factory.local.*` are rejected,
 * and so is any value that is an absolute local path.
 */
export function sessionContextAttributeProblems(attributes: Readonly<Record<string, string>>): string[] {
  const problems: string[] = [];
  for (const [key, value] of Object.entries(attributes)) {
    if (SESSION_CONTEXT_FORBIDDEN_ATTR_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      problems.push(`${key}: ${LOCAL_ATTR_PREFIX}* attributes hold local paths and never go in a session context`);
    } else if (ABSOLUTE_PATH_VALUE.test(value)) {
      problems.push(`${key}: value is a local path; session context attributes never hold paths`);
    }
  }
  return problems;
}

/** Throws when {@link sessionContextAttributeProblems} reports anything. */
export function assertSessionContextAttributes(attributes: Readonly<Record<string, string>>): void {
  const problems = sessionContextAttributeProblems(attributes);
  if (problems.length) throw new Error(`session context attributes rejected: ${problems.join('; ')}`);
}

const IsoTimestampSchema = z.iso.datetime({ offset: true });

export const SessionContextAttributesSchema = z
  .record(z.string().min(1).max(256), z.string().max(4096))
  .superRefine((attributes, ctx) => {
    for (const message of sessionContextAttributeProblems(attributes)) ctx.addIssue({ code: 'custom', message });
  });

/** Fields of a segment, without the cross-field check (for composing other schemas). */
export const SESSION_SEGMENT_SHAPE = {
  from: IsoTimestampSchema,
  /** `null` while the segment is open. */
  to: IsoTimestampSchema.nullable(),
  reason: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  attributes: SessionContextAttributesSchema,
};

/** True when a segment's `to` is not before its `from`. */
export function isSegmentIntervalValid(segment: { from: string; to: string | null }): boolean {
  return segment.to === null || Date.parse(segment.to) >= Date.parse(segment.from);
}

export const SessionSegmentSchema = z.object(SESSION_SEGMENT_SHAPE).refine(isSegmentIntervalValid, {
  message: 'segment `to` is before `from`',
  path: ['to'],
});
export type SessionSegment = z.infer<typeof SessionSegmentSchema>;

export const SessionContextSchema = z
  .object({
    version: z.literal(SESSION_CONTEXT_VERSION),
    agentTool: SessionContextAgentToolSchema,
    sessionId: SessionContextSessionIdSchema,
    segments: z.array(SessionSegmentSchema),
  })
  .superRefine((context, ctx) => {
    // Segments are in time order and never overlap: at any time at most one is in force,
    // and only the last one may still be open.
    context.segments.forEach((segment, index) => {
      const next = context.segments[index + 1];
      if (!next) return;
      if (segment.to === null) {
        ctx.addIssue({ code: 'custom', message: 'only the last segment may be open', path: ['segments', index, 'to'] });
      } else if (Date.parse(next.from) < Date.parse(segment.to)) {
        ctx.addIssue({
          code: 'custom',
          message: 'segments must be in time order and must not overlap',
          path: ['segments', index + 1, 'from'],
        });
      }
    });
  });
export type SessionContext = z.infer<typeof SessionContextSchema>;

/** Attribute that names a segment's attempt (Factory Commits telemetry profile). */
export const SESSION_CONTEXT_ATTEMPT_ATTR = 'factory.attempt.id';

/** `<agent-tool>/<session-id>.json`, relative to {@link SESSION_CONTEXT_DIR}. Throws on unsafe ids. */
export function sessionContextRelativePath(agentTool: string, sessionId: string): string {
  return `${SessionContextAgentToolSchema.parse(agentTool)}/${SessionContextSessionIdSchema.parse(sessionId)}.json`;
}

export interface SegmentInForceOptions {
  /**
   * Attempts already ended (completed or torn down). An open segment of an ended
   * attempt is closed for every reader, even before the CLI writes its `to`
   * (ADR 0004 section 2).
   */
  isAttemptEnded?: (attemptId: string) => boolean;
}

function toMillis(timestamp: Date | string | number): number {
  if (timestamp instanceof Date) return timestamp.getTime();
  return typeof timestamp === 'number' ? timestamp : Date.parse(timestamp);
}

/**
 * The segment in force at `timestamp`, or `undefined` (the session worked outside
 * any attempt: stamp nothing). Intervals are half-open, `[from, to)`, so at a
 * relaunch instant the new segment is in force.
 */
export function segmentInForce(
  context: Pick<SessionContext, 'segments'>,
  timestamp: Date | string | number,
  options: SegmentInForceOptions = {},
): SessionSegment | undefined {
  const at = toMillis(timestamp);
  if (Number.isNaN(at)) return undefined;
  for (let i = context.segments.length - 1; i >= 0; i--) {
    const segment = context.segments[i];
    if (at < Date.parse(segment.from)) continue;
    if (segment.to !== null) return at < Date.parse(segment.to) ? segment : undefined;
    const attemptId = segment.attributes[SESSION_CONTEXT_ATTEMPT_ATTR];
    if (attemptId && options.isAttemptEnded?.(attemptId)) return undefined;
    return segment;
  }
  return undefined;
}
