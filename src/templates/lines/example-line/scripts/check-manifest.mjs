#!/usr/bin/env node
/**
 * Validate this line bundle without installing it.
 *
 * Checks the invariants that make a line a line — most importantly that the
 * manifest declares no `verificationStages`, so applying it can never widen
 * `har env verify --full`.
 *
 * Usage: node scripts/check-manifest.mjs [bundle-dir]
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const bundleDir = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
const errors = [];
const warnings = [];

function readJson(relPath) {
  const abs = join(bundleDir, relPath);
  if (!existsSync(abs)) {
    errors.push(`missing file: ${relPath}`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(abs, 'utf8'));
  } catch (err) {
    errors.push(`invalid JSON in ${relPath}: ${err.message}`);
    return null;
  }
}

const manifest = readJson('line.manifest.json');

if (manifest) {
  if (manifest.kind !== 'line') {
    errors.push('line.manifest.json must declare "kind": "line" (a plugin manifest is not a line)');
  }
  if (manifest.verificationStages !== undefined) {
    errors.push(
      'line.manifest.json must NOT declare verificationStages — line gate stages are opt-in and run via `har line gate`',
    );
  }
  if (typeof manifest.id !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(manifest.id)) {
    errors.push('line.manifest.json id must be a lowercase slug');
  }
  for (const file of manifest.files ?? []) {
    if (!existsSync(join(bundleDir, file.src))) {
      errors.push(`files[].src not found: ${file.src}`);
    }
  }
}

const program = manifest ? readJson(manifest.program ?? 'line.json') : null;

if (manifest && program) {
  if (program.id !== manifest.id) {
    errors.push(`program id "${program.id}" does not match manifest id "${manifest.id}"`);
  }
  if (program.contractVersion !== 1) {
    errors.push('program contractVersion must be 1');
  }
  if (program.gate?.cumulative !== true) {
    errors.push('gate.cumulative must be true — a line never drops an earlier station\'s stages');
  }
  if (program.handoff?.autonomousShip !== false) {
    errors.push('handoff.autonomousShip must be false — agents hand off, they do not ship');
  }

  const stationIds = (program.stations ?? []).map((s) => s.id);
  if (stationIds.length === 0) {
    errors.push('program needs at least one station');
  }
  if (new Set(stationIds).size !== stationIds.length) {
    errors.push('station ids must be unique');
  }

  const registeredIds = new Set((manifest.stages ?? []).map((s) => s.id));
  for (const stage of program.gate?.stages ?? []) {
    if (!stationIds.includes(stage.fromStation)) {
      errors.push(`gate stage "${stage.id}" tags unknown station "${stage.fromStation}"`);
    }
    if (!registeredIds.has(stage.id)) {
      warnings.push(
        `gate stage "${stage.id}" is not registered by this bundle — the target repo must already provide it (e.g. via a verification plugin)`,
      );
    }
  }
}

for (const warning of warnings) {
  console.warn(`warn: ${warning}`);
}

if (errors.length > 0) {
  for (const err of errors) {
    console.error(`error: ${err}`);
  }
  console.error(`\n${errors.length} error(s) in ${bundleDir}`);
  process.exit(1);
}

console.log(`ok: ${bundleDir} is a valid HAR line bundle`);
