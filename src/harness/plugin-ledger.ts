import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { writeFileSafe } from '../utils/file-ops';
import { DEFAULT_HAR_DIR } from './manifest';

export const PluginLedgerEntrySchema = z.object({
  id: z.string().min(1),
  source: z.enum(['bundled', 'local', 'path', 'npm', 'git']),
  /** Original install spec (id, path, package, or git URL). */
  spec: z.string().min(1),
  /** Package/plugin version when known. */
  version: z.string().optional(),
  stageIds: z.array(z.string().min(1)).min(1),
  installedAt: z.string(),
});

export type PluginLedgerEntry = z.infer<typeof PluginLedgerEntrySchema>;

export const PluginLedgerSchema = z.object({
  version: z.literal('1'),
  /** Profile used at init, when known. */
  profile: z.enum(['default', 'cli', 'ios']).optional(),
  /** Ordered runtime bundles that composed the harness scaffold. */
  bundles: z.array(z.string().min(1)).optional(),
  plugins: z.array(PluginLedgerEntrySchema).default([]),
});

export type PluginLedger = z.infer<typeof PluginLedgerSchema>;

export function getPluginLedgerPath(repoPath: string): string {
  return path.join(path.resolve(repoPath), DEFAULT_HAR_DIR, 'plugins.json');
}

export function readPluginLedger(repoPath: string): PluginLedger | null {
  const ledgerPath = getPluginLedgerPath(repoPath);
  if (!fs.existsSync(ledgerPath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) as unknown;
    const parsed = PluginLedgerSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function writePluginLedger(repoPath: string, ledger: PluginLedger): void {
  const ledgerPath = getPluginLedgerPath(repoPath);
  const harnessDir = path.dirname(ledgerPath);
  if (!fs.existsSync(harnessDir)) {
    fs.mkdirSync(harnessDir, { recursive: true });
  }
  writeFileSafe(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
}

export function upsertPluginLedgerEntry(
  repoPath: string,
  entry: PluginLedgerEntry,
  extras?: Pick<PluginLedger, 'profile' | 'bundles'>,
): PluginLedger {
  const existing = readPluginLedger(repoPath) ?? {
    version: '1' as const,
    plugins: [],
  };
  const plugins = existing.plugins.filter((p) => p.id !== entry.id);
  plugins.push(entry);
  plugins.sort((a, b) => a.id.localeCompare(b.id));

  const ledger: PluginLedger = {
    version: '1',
    profile: extras?.profile ?? existing.profile,
    bundles: extras?.bundles ?? existing.bundles,
    plugins,
  };
  writePluginLedger(repoPath, ledger);
  return ledger;
}

export function ensurePluginLedgerScaffold(
  repoPath: string,
  options: { profile?: PluginLedger['profile']; bundles?: string[] },
): PluginLedger {
  const existing = readPluginLedger(repoPath);
  const ledger: PluginLedger = {
    version: '1',
    profile: options.profile ?? existing?.profile,
    bundles: options.bundles ?? existing?.bundles,
    plugins: existing?.plugins ?? [],
  };
  writePluginLedger(repoPath, ledger);
  return ledger;
}
