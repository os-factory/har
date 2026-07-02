import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

interface ChangedFileEntry {
  path: string;
  status: string;
  oldPath?: string;
}

export interface ChangeBatchRow {
  id: string;
  treeHash: string;
  branch: string | null;
  agentId: number | null;
  status: string;
  full: boolean;
  runId: string | null;
  changedFiles: ChangedFileEntry[];
  commitSha: string | null;
  createdAt: Date;
}

function batchBadge(batch: ChangeBatchRow) {
  if (batch.status === 'pass' && batch.full) {
    return <Badge variant="success">Verified</Badge>;
  }
  if (batch.status === 'pass') {
    return <Badge variant="secondary">Partial verify</Badge>;
  }
  return <Badge variant="destructive">Failed</Badge>;
}

function filesSummary(files: ChangedFileEntry[]): string {
  return files
    .slice(0, 10)
    .map((f) => `${f.status} ${f.path}`)
    .join('\n');
}

export function ChangeBatchList({ batches }: { batches: ChangeBatchRow[] }) {
  if (batches.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No change batches synced yet. Batches are recorded when `har env verify` runs.
      </p>
    );
  }

  const byBranch = new Map<string, ChangeBatchRow[]>();
  for (const batch of batches) {
    const key = batch.branch ?? '(no branch)';
    const group = byBranch.get(key) ?? [];
    group.push(batch);
    byBranch.set(key, group);
  }

  return (
    <div className="space-y-6">
      {[...byBranch.entries()].map(([branch, group]) => (
        <div key={branch}>
          <h3 className="mb-2 font-mono text-sm font-semibold text-muted-foreground">{branch}</h3>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Created</TableHead>
                <TableHead>Batch</TableHead>
                <TableHead>Files</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Run</TableHead>
                <TableHead>Commit</TableHead>
                <TableHead>Agent</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {group.map((batch) => (
                <TableRow key={batch.id}>
                  <TableCell className="text-muted-foreground">
                    {batch.createdAt.toLocaleString()}
                  </TableCell>
                  <TableCell className="font-mono">{batch.treeHash.slice(0, 8)}</TableCell>
                  <TableCell title={filesSummary(batch.changedFiles)}>
                    {batch.changedFiles.length}
                  </TableCell>
                  <TableCell>{batchBadge(batch)}</TableCell>
                  <TableCell className="font-mono">
                    {batch.runId ? batch.runId.slice(0, 8) : '—'}
                  </TableCell>
                  <TableCell className="font-mono">
                    {batch.commitSha ? batch.commitSha.slice(0, 8) : '—'}
                  </TableCell>
                  <TableCell>{batch.agentId ?? '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ))}
    </div>
  );
}
