import { z } from 'zod';
import { AgentToolSchema, HAR_AGENT_SLOT_MIN, type AgentTool } from './schema';

/**
 * Session → slot attribution contract (ADR 0003).
 *
 * LLM usage is attributed per observation (one API request, turn or
 * generation) to the slot its agent was working in at that moment. The slot is
 * read from a timeline of bindings built only from evidence — never guessed.
 * Usage with no binding is reported as the session's unassigned (main checkout)
 * usage, never booked on a slot.
 *
 * Producers:
 * - HAR CLI: `launch` / `release` bindings (the launching agent session is read
 *   from the env its agent gives to every command it runs), and harvested usage
 *   observations (transcripts / rollouts).
 * - otel-hook spans: `observed` bindings (the worktree a tool event targeted)
 *   and per-generation usage (Cursor, Codex).
 * - Claude Code / Codex native OTLP: per-request usage observations.
 * Mission Control stores bindings and observations as facts and derives slot
 * usage from them, so late evidence re-attributes instead of being frozen.
 */

/**
 * `agentId` of a span, event or trajectory record whose session had no slot
 * binding in force when it happened: the main checkout. Never a slot number
 * (slots start at `HAR_AGENT_SLOT_MIN`), so no slot page claims it.
 */
export const MAIN_CHECKOUT_AGENT_ID = 0;

/** Env var each agent sets, for every command it runs, to its session id. */
export const AGENT_SESSION_ENV: Readonly<Record<AgentTool, string>> = {
  claude_code: 'CLAUDE_CODE_SESSION_ID',
  codex: 'CODEX_THREAD_ID',
  cursor: 'CURSOR_CONVERSATION_ID',
};

/**
 * Span attributes otel-hook adds to a tool event when it can tell which git
 * worktree the event targeted (an edited/read file path, a shell command's
 * working directory). Paths never leave the machine: only the branch name and
 * a salted hash of the worktree root are exported.
 */
export const TARGET_BRANCH_ATTR = 'vcs.ref.head.name';
export const TARGET_WORKSPACE_ID_ATTR = 'otelhook.target.workspace.id';
/** What the target was derived from: `tool-path` | `shell-cwd` | `session-cwd`. */
export const TARGET_SOURCE_ATTR = 'otelhook.target.source';
/** The provider's own subagent id (Claude `agent_id`, Cursor subagent conversation id). */
export const SUBAGENT_ID_ATTR = 'otelhook.subagent.id';

/** Identity of one agent context: a session, or one subagent inside it. */
export const AgentSessionRefSchema = z.object({
  agentTool: AgentToolSchema,
  /** The provider's session id (Claude `session_id`, Codex thread id, Cursor conversation id). */
  sessionId: z.string().min(1).max(256),
  /** Set for a subagent; its bindings fall back to the parent session's. */
  subagentId: z.string().min(1).max(256).optional(),
});
export type AgentSessionRef = z.infer<typeof AgentSessionRefSchema>;

/**
 * How a binding was established, strongest first:
 * - `launch`    — `har env launch` (CLI or MCP) ran inside this session.
 * - `release`   — `har env teardown` / `complete` ran inside it; closes the binding.
 * - `workspace` — the session itself runs inside the slot's work dir.
 * - `observed`  — a tool event of the session targeted the slot's worktree.
 */
export const SessionBindingKindSchema = z.enum(['launch', 'release', 'workspace', 'observed']);
export type SessionBindingKind = z.infer<typeof SessionBindingKindSchema>;

/**
 * One timeline point: from `at` on, `ref` works in slot `slotId` (or, for
 * `release`, no longer does). The binding in force at time t is the latest one
 * at or before t for the subagent, else for its parent session.
 */
export const SessionSlotBindingSchema = AgentSessionRefSchema.extend({
  kind: SessionBindingKindSchema,
  slotId: z.number().int().min(HAR_AGENT_SLOT_MIN),
  /** One occupancy of the slot (#316): a binding never outlives it. */
  occupancyKey: z.string().min(1).optional(),
  branch: z.string().min(1).optional(),
  at: z.string().datetime(),
});
export type SessionSlotBinding = z.infer<typeof SessionSlotBindingSchema>;

export const SyncSessionBindingsInputSchema = z.object({
  bindings: z.array(SessionSlotBindingSchema),
});
export type SyncSessionBindingsInput = z.infer<typeof SyncSessionBindingsInputSchema>;

/** What one observation covers — the finest unit its provider reports. */
export const UsageGranularitySchema = z.enum(['request', 'turn', 'generation', 'message']);
export type UsageGranularity = z.infer<typeof UsageGranularitySchema>;

/**
 * One billable unit of LLM usage, as reported. Observations are facts: never
 * merged into each other, idempotent on `(agentTool, sessionId, observationKey)`,
 * and attributed to a slot only when slot usage is derived.
 */
export const UsageObservationSchema = AgentSessionRefSchema.extend({
  /**
   * Stable producer id for idempotency, the same for a live and a harvested
   * copy of one unit: Claude `request_id` (transcript `requestId`), Codex
   * `turn_id`, Cursor generation id.
   */
  observationKey: z.string().min(1).max(512),
  observedAt: z.string().datetime(),
  granularity: UsageGranularitySchema,
  source: z.enum(['otel', 'harvest']),
  model: z.string().min(1).optional(),
  tokensInput: z.number().int().nonnegative().default(0),
  tokensOutput: z.number().int().nonnegative().default(0),
  tokensCacheRead: z.number().int().nonnegative().default(0),
  tokensCacheCreation: z.number().int().nonnegative().default(0),
  /** Cost the provider reported for this unit; when absent it is estimated from the model price. */
  costUsd: z.number().nonnegative().optional(),
});
export type UsageObservation = z.infer<typeof UsageObservationSchema>;

export const SyncUsageObservationsInputSchema = z.object({
  observations: z.array(UsageObservationSchema),
});
export type SyncUsageObservationsInput = z.infer<typeof SyncUsageObservationsInputSchema>;

/**
 * Read the session of the agent running the current process, if any.
 *
 * Agents nest — Codex run from a Claude Code shell, Claude Code started from a
 * Cursor agent terminal — and each inherits the variables of the agents above
 * it, so several may be set at once. The session belongs to the **innermost**
 * agent, which only the process tree tells: callers pass `innermostTool`, the
 * nearest agent among the process's ancestors. With several variables set and
 * no innermost agent known, the session is ambiguous and none is returned —
 * never a guess.
 */
export function launchingAgentSession(
  env: Readonly<Record<string, string | undefined>>,
  innermostTool?: AgentTool | null,
): { agentTool: AgentTool; sessionId: string } | null {
  const present: Array<{ agentTool: AgentTool; sessionId: string }> = [];
  for (const [agentTool, name] of Object.entries(AGENT_SESSION_ENV) as Array<[AgentTool, string]>) {
    const raw = env[name]?.trim().replace(/^'(.*)'$/, '$1');
    if (raw && AgentSessionRefSchema.shape.sessionId.safeParse(raw).success) {
      present.push({ agentTool, sessionId: raw });
    }
  }
  if (innermostTool) {
    const innermost = present.find((session) => session.agentTool === innermostTool);
    if (innermost) return innermost;
  }
  return present.length === 1 ? present[0] : null;
}
