import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { GENAI_PRICES_LABEL, GENAI_PRICES_VERSION, generatePricingVectors } from '@har/schemas';
import { observationPricing } from '@/server/session-attribution';

/**
 * Pricing at ingest (ADR 0005 section 5): Mission Control prices every row
 * with the shared `model-pricing.ts` and records the genai-prices release. The
 * committed test vectors let another receiver check it gives the same numbers.
 */

const SCHEMAS_DIR = path.resolve(__dirname, '../../../packages/schemas');

function installedGenaiPricesVersion(): string {
  const entry = require.resolve('@pydantic/genai-prices', { paths: [SCHEMAS_DIR] });
  let dir = path.dirname(entry);
  while (!fs.existsSync(path.join(dir, 'package.json')) || !dir.endsWith('genai-prices')) dir = path.dirname(dir);
  return (JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { version: string }).version;
}

describe('pricing at ingest', () => {
  it('records the genai-prices release that is installed', () => {
    expect(GENAI_PRICES_VERSION).toBe(installedGenaiPricesVersion());
    expect(GENAI_PRICES_LABEL).toBe(`genai-prices@${GENAI_PRICES_VERSION}`);
  });

  it('keeps packages/schemas/pricing-vectors.json up to date (npm run pricing-vectors in packages/schemas)', () => {
    const committed = JSON.parse(fs.readFileSync(path.join(SCHEMAS_DIR, 'pricing-vectors.json'), 'utf8')) as {
      vectors: unknown[];
    };
    expect(committed.vectors).toEqual(generatePricingVectors());
  });

  it('prices every vector at ingest as the vectors expect, and keeps a reported cost', () => {
    for (const vector of generatePricingVectors()) {
      const priced = observationPricing({
        agentTool: vector.provider,
        model: vector.model,
        tokensInput: vector.tokensInput,
        tokensOutput: vector.tokensOutput,
        tokensCacheRead: vector.tokensCacheRead,
        tokensCacheCreation: vector.tokensCacheCreation,
        costUsd: null,
        costSource: null,
      });
      expect(priced.costUsd, `${vector.provider} ${vector.model}`).toBe(vector.expectedCostUsd);
      expect(priced.pricedWith).toBe(vector.expectedCostUsd == null ? null : vector.pricedWith);
    }
    expect(
      observationPricing({
        agentTool: 'claude_code',
        model: 'claude-sonnet-4-5',
        tokensInput: 1000,
        tokensOutput: 500,
        tokensCacheRead: 0,
        tokensCacheCreation: 0,
        costUsd: 0.5,
        costSource: 'reported',
      }),
    ).toEqual({ costUsd: 0.5, costSource: 'reported', pricedWith: null });
  });
});
