#!/usr/bin/env node
import { writeFileSync } from 'fs';
import { generatePricingVectors } from './pricing-vectors';

/**
 * `node packages/schemas/dist/pricing-vectors-cli.js [--out <file>]`
 *
 * Prints the pricing test vectors as JSON (or writes them to `--out`), so a
 * receiver outside this repository can check its pricing against HAR's.
 */
export function pricingVectorsJson(): string {
  return `${JSON.stringify({ vectors: generatePricingVectors() }, null, 2)}\n`;
}

if (require.main === module) {
  const at = process.argv.indexOf('--out');
  const json = pricingVectorsJson();
  if (at !== -1 && process.argv[at + 1]) writeFileSync(process.argv[at + 1], json);
  else process.stdout.write(json);
}
