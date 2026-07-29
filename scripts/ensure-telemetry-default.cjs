#!/usr/bin/env node
/**
 * npm postinstall: persist full default telemetry preference when missing.
 * Does not overwrite an existing ~/.har/telemetry.json (respects prior off / prompts=false).
 * Hooks + Mission Control are activated on first `har` / `har env launch` / `har telemetry on`.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function main() {
  if (process.env.HAR_SKIP_TELEMETRY_POSTINSTALL === '1') return;

  const preferencePath =
    process.env.HAR_TELEMETRY_CONFIG_PATH || path.join(os.homedir(), '.har', 'telemetry.json');

  if (fs.existsSync(preferencePath)) return;

  const preference = {
    enabled: true,
    signals: {
      metrics: true,
      logs: true,
      prompts: true,
      traces: true,
    },
    updatedAt: new Date().toISOString(),
  };

  fs.mkdirSync(path.dirname(preferencePath), { recursive: true });
  fs.writeFileSync(preferencePath, `${JSON.stringify(preference, null, 2)}\n`);
}

try {
  main();
} catch {
  // Never fail npm install over telemetry preference write.
}
