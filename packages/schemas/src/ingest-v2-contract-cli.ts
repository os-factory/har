#!/usr/bin/env node
import { formatIngestV2ContractReport, runIngestV2Contract } from './ingest-v2-contract';

/**
 * `node packages/schemas/dist/ingest-v2-contract-cli.js <baseUrl> [--header name:value]...`
 *
 * Runs the ingest v2 contract checks against a receiver and prints one
 * PASS/FAIL/SKIP line per check. Exit code: 0 when every check passed, 1 when
 * one failed, 2 on a usage error.
 */

export const INGEST_V2_CONTRACT_CLI_USAGE =
  'usage: ingest-v2-contract <ingest-base-url> [--header name:value]...\n' +
  '  example: ingest-v2-contract http://localhost:3847/api';

export interface IngestV2ContractCliIo {
  out: (line: string) => void;
  err: (line: string) => void;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

/** Parse `argv` (without node and script), run the checks, return the exit code. */
export async function ingestV2ContractCliMain(argv: readonly string[], io: IngestV2ContractCliIo): Promise<number> {
  const headers: Record<string, string> = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      io.out(INGEST_V2_CONTRACT_CLI_USAGE);
      return 0;
    }
    if (arg === '--header' || arg.startsWith('--header=')) {
      const value = arg === '--header' ? argv[++i] : arg.slice('--header='.length);
      const colon = value?.indexOf(':') ?? -1;
      if (!value || colon <= 0) {
        io.err(`--header needs name:value\n${INGEST_V2_CONTRACT_CLI_USAGE}`);
        return 2;
      }
      headers[value.slice(0, colon).trim()] = value.slice(colon + 1).trim();
      continue;
    }
    if (arg.startsWith('-')) {
      io.err(`unknown option ${arg}\n${INGEST_V2_CONTRACT_CLI_USAGE}`);
      return 2;
    }
    positionals.push(arg);
  }
  if (positionals.length !== 1) {
    io.err(INGEST_V2_CONTRACT_CLI_USAGE);
    return 2;
  }
  try {
    new URL(positionals[0]);
  } catch {
    io.err(`not a URL: ${positionals[0]}\n${INGEST_V2_CONTRACT_CLI_USAGE}`);
    return 2;
  }

  const results = await runIngestV2Contract({ baseUrl: positionals[0], headers, fetch: io.fetch });
  io.out(formatIngestV2ContractReport(results));
  const failed = results.filter((r) => !r.pass).length;
  io.out(failed ? `${failed} of ${results.length} checks failed` : `all ${results.length} checks passed`);
  return failed ? 1 : 0;
}

if (require.main === module) {
  ingestV2ContractCliMain(process.argv.slice(2), {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  }).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`ingest-v2-contract: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 2;
    },
  );
}
