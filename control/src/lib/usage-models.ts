/** Extract model ids (and optional per-model totals) from AgentSessionUsage.modelBreakdown. */

export interface UsageModelTotals {
  tokensInput?: number;
  tokensOutput?: number;
  tokensCacheRead?: number;
  tokensCacheCreation?: number;
  tokensTotal?: number;
  /** USD cost for this model (agent-reported or genai-prices estimate). */
  costUsd?: number;
}

export function modelsFromBreakdown(breakdown: unknown): string[] {
  if (!breakdown || typeof breakdown !== 'object' || Array.isArray(breakdown)) return [];
  return Object.keys(breakdown as Record<string, unknown>).filter(Boolean).sort();
}

export function modelTotalsFromBreakdown(
  breakdown: unknown,
): Array<{ model: string; totals: UsageModelTotals }> {
  if (!breakdown || typeof breakdown !== 'object' || Array.isArray(breakdown)) return [];
  return Object.entries(breakdown as Record<string, unknown>)
    .filter(([model]) => Boolean(model))
    .map(([model, value]) => {
      const totals =
        value && typeof value === 'object' && !Array.isArray(value)
          ? (value as UsageModelTotals)
          : {};
      return { model, totals };
    })
    .sort((a, b) => a.model.localeCompare(b.model));
}

/** Format model id for badges (strip common cursor- prefix noise). */
export function formatModelId(model: string): string {
  return model.replace(/^cursor-/, '');
}

export function formatCostUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `$${value.toFixed(4)}`;
}

/** Compact token count for tables and summary cards. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

/** Global search matcher for Usage session rows (repository, slot, session, agent, sources). */
export function matchesUsageSearch(
  row: {
    repositoryPath: string;
    agentId: number;
    sessionKey: string;
    agentTool: string;
    sources: string[];
  },
  filterValue: string,
  agentLabel: (tool: string) => string = (tool) => tool,
): boolean {
  const q = filterValue.trim().toLowerCase();
  if (!q) return true;
  const repoName = row.repositoryPath.split('/').pop() ?? row.repositoryPath;
  return (
    repoName.toLowerCase().includes(q) ||
    row.repositoryPath.toLowerCase().includes(q) ||
    String(row.agentId).includes(q) ||
    row.sessionKey.toLowerCase().includes(q) ||
    row.agentTool.toLowerCase().includes(q) ||
    agentLabel(row.agentTool).toLowerCase().includes(q) ||
    row.sources.some((source) => source.toLowerCase().includes(q))
  );
}
