import { calcPrice, type Provider, type Usage } from '@pydantic/genai-prices';

/**
 * Temporary Cursor provider catalog until pydantic/genai-prices#537 merges.
 * Source: https://github.com/pydantic/genai-prices/pull/537
 * Pricing: https://cursor.com/docs/models-and-pricing
 */
export const CURSOR_PRICING_PROVIDER: Provider = {
  id: 'cursor',
  name: 'Cursor',
  pricing_urls: ['https://cursor.com/docs/models-and-pricing'],
  api_pattern: String.raw`https://(.*\.)?cursor\.(com|sh)`,
  model_match: {
    or: [{ starts_with: 'composer' }, { contains: 'grok-4.5' }],
  },
  provider_match: { contains: 'cursor' },
  models: [
    {
      id: 'composer-2.5-fast',
      name: 'Composer 2.5 (Fast)',
      description: 'Fast-mode variant of Composer 2.5.',
      match: {
        or: [
          { equals: 'composer-2.5-fast' },
          { equals: 'cursor-composer-2.5-fast' },
        ],
      },
      prices: {
        input_mtok: 3,
        cache_read_mtok: 0.5,
        output_mtok: 15,
      },
    },
    {
      id: 'composer-2.5',
      name: 'Composer 2.5',
      description: "Cursor's own agentic coding model.",
      match: {
        or: [
          { equals: 'composer-2.5' },
          { equals: 'cursor-composer-2.5' },
        ],
      },
      prices: {
        input_mtok: 0.5,
        cache_read_mtok: 0.2,
        output_mtok: 2.5,
      },
    },
    {
      id: 'grok-4.5-fast',
      name: 'Grok 4.5 (Fast)',
      description: 'Fast-mode variant of Grok 4.5.',
      match: {
        or: [
          { equals: 'grok-4.5-fast' },
          { equals: 'grok-4.5-high-fast' },
          { equals: 'cursor-grok-4.5-high-fast' },
          { equals: 'cursor-grok-4.5-fast' },
        ],
      },
      prices: {
        input_mtok: 4,
        cache_read_mtok: 1,
        output_mtok: 18,
      },
    },
    {
      id: 'grok-4.5',
      name: 'Grok 4.5',
      description:
        'Jointly trained by Cursor and SpaceXAI for long-running coding and knowledge work.',
      match: {
        or: [
          { equals: 'grok-4.5' },
          { equals: 'grok-4.5-high' },
          { equals: 'cursor-grok-4.5-high' },
          { equals: 'cursor-grok-4.5' },
        ],
      },
      prices: {
        input_mtok: 2,
        cache_read_mtok: 0.5,
        output_mtok: 6,
      },
    },
  ],
};

/** True when the model id looks like a Cursor-native slug (Composer / Grok 4.5). */
export function isCursorNativeModel(modelId: string): boolean {
  const id = modelId.toLowerCase();
  const normalized = id.startsWith('cursor-') ? id.slice('cursor-'.length) : id;
  return normalized.startsWith('composer') || normalized.includes('grok-4.5');
}

/** Price a Cursor-native model using the temporary overlay catalog. */
export function estimateCursorNativeCostUsd(usage: Usage, modelId: string): number | null {
  if (!isCursorNativeModel(modelId)) return null;
  try {
    const result = calcPrice(usage, modelId, { provider: CURSOR_PRICING_PROVIDER });
    return result?.total_price ?? null;
  } catch {
    return null;
  }
}
