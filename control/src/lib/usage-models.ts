/** Extract model ids (and optional per-model totals) from AgentSessionUsage.modelBreakdown. */

export interface UsageModelTotals {
  tokensInput?: number;
  tokensOutput?: number;
  tokensCacheRead?: number;
  tokensCacheCreation?: number;
  tokensTotal?: number;
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
