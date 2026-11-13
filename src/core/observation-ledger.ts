import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Which usage observations Mission Control has already accepted, by content
 * fingerprint, per (Mission Control URL, repo id).
 *
 * Every sync used to re-post every observation of every session, and Mission
 * Control re-checks each one in its own round-trip — seconds per repo for
 * nothing new. An observation is posted again only when its content changed.
 * Keyed on the repo id like the runs watermark, so a wiped Mission Control
 * (new repo id) gets everything again.
 */

type Ledger = Record<string, string[]>;

function ledgerPath(): string {
  if (process.env.HAR_OBSERVATION_LEDGER_PATH) {
    return path.resolve(process.env.HAR_OBSERVATION_LEDGER_PATH);
  }
  return path.join(os.homedir(), '.har', 'cache', 'observation-ledger.json');
}

function readLedger(): Ledger {
  try {
    const parsed = JSON.parse(fs.readFileSync(ledgerPath(), 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Ledger) : {};
  } catch {
    return {};
  }
}

function ledgerKey(apiUrl: string, repoId: string): string {
  return `${apiUrl}|${repoId}`;
}

export function observationFingerprint(observation: unknown): string {
  return createHash('sha1').update(JSON.stringify(observation)).digest('hex');
}

/** The observations Mission Control has not accepted in this exact form yet. */
export function unsentObservations<T>(apiUrl: string, repoId: string, observations: T[]): T[] {
  const sent = new Set(readLedger()[ledgerKey(apiUrl, repoId)] ?? []);
  if (sent.size === 0) return observations;
  return observations.filter((observation) => !sent.has(observationFingerprint(observation)));
}

/**
 * Record what Mission Control accepted. `current` is every observation this
 * sync collected, so fingerprints of observations that no longer exist (a
 * changed row's old form) are dropped instead of growing forever.
 */
export function recordSentObservations<T>(
  apiUrl: string,
  repoId: string,
  current: T[],
  accepted: T[],
): void {
  try {
    const ledger = readLedger();
    const key = ledgerKey(apiUrl, repoId);
    const currentPrints = new Set(current.map(observationFingerprint));
    const kept = (ledger[key] ?? []).filter((print) => currentPrints.has(print));
    ledger[key] = [...new Set([...kept, ...accepted.map(observationFingerprint)])];
    const file = ledgerPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(ledger));
    fs.renameSync(tmp, file);
  } catch {
    // Losing the ledger only costs a full re-post on the next sync.
  }
}
