/**
 * `@osfactory/har/attribution` — the library entry har-portal imports, so it
 * derives slot usage with the same code as Mission Control (ADR 0003).
 *
 * Free of zod and of the HAR domain schema: the consumer may run another zod
 * major, so the wire contract travels as plain types and each side validates
 * it with its own schemas (`PortalSessionAttributionInputSchema` here).
 */
export * from './usage-attribution';
export { estimateModelCostUsd, type ModelUsageTotals } from './model-pricing';

export type AgentToolName = 'claude_code' | 'codex' | 'cursor';

/** One timeline point of `POST /api/session-attribution` (`SessionSlotBindingSchema`). */
export interface PortalSessionBinding {
  agentTool: AgentToolName;
  sessionId: string;
  subagentId?: string;
  kind: 'launch' | 'release' | 'workspace' | 'observed';
  slotId: number;
  occupancyKey?: string;
  branch?: string;
  at: string;
}

/** One billable unit of usage (`PortalUsageObservationSchema`). */
export interface PortalUsageObservationWire {
  agentTool: AgentToolName;
  sessionId: string;
  subagentId?: string;
  observationKey: string;
  observedAt: string;
  granularity: 'request' | 'turn' | 'generation' | 'message';
  source: 'otel' | 'harvest';
  producer: string;
  model?: string;
  tokensInput: number;
  tokensOutput: number;
  tokensCacheRead: number;
  tokensCacheCreation: number;
  costUsd?: number;
  userEmail?: string;
}

/** A provider-reported session total, for the cross-check (`ReportedSessionUsageSchema`). */
export interface ReportedSessionUsageWire {
  agentTool: AgentToolName;
  sessionId: string;
  costUsd: number | null;
  tokensTotal: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface PortalSessionAttributionWire {
  path: string;
  gitRemote?: string;
  bindings: PortalSessionBinding[];
  observations: PortalUsageObservationWire[];
  reportedUsage: ReportedSessionUsageWire[];
}
