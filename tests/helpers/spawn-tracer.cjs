'use strict';
/**
 * Process-spawn tracer for cost guards. Load with
 *   NODE_OPTIONS="--require /abs/path/spawn-tracer.cjs" HAR_SPAWN_TRACE=/abs/trace.jsonl
 * and every child_process call the CLI makes is appended to the trace as one
 * JSON line `{ fn, command }` before it runs. Patched on the module exports,
 * so bundled code that calls `(0, child_process.execSync)(…)` is traced too.
 * Node's own exec → spawn chains call internal functions, not the exports,
 * so one public call is recorded once.
 */
const childProcess = require('child_process');
const fs = require('fs');

const traceFile = process.env.HAR_SPAWN_TRACE;

if (traceFile) {
  const record = (fn, file, args) => {
    const command =
      Array.isArray(args) && args.length > 0 ? [file, ...args.map(String)].join(' ') : String(file);
    try {
      fs.appendFileSync(traceFile, JSON.stringify({ fn, command }) + '\n');
    } catch {
      // never break the traced program
    }
  };

  for (const fn of ['execSync', 'exec', 'execFileSync', 'execFile', 'spawnSync', 'spawn']) {
    const original = childProcess[fn];
    if (typeof original !== 'function') continue;
    childProcess[fn] = function traced(file, args, ...rest) {
      record(fn, file, Array.isArray(args) ? args : undefined);
      return original.call(this, file, args, ...rest);
    };
  }
}
