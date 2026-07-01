import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

export interface RunRow {
  id: string;
  runId: string;
  stageId: string;
  agentId: number | null;
  status: string;
  trigger: string;
  durationMs: number | null;
  startedAt: Date;
}

export function RunTimeline({ runs }: { runs: RunRow[] }) {
  if (runs.length === 0) {
    return <p className="text-sm text-muted-foreground">No runs synced yet.</p>;
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Time</TableHead>
          <TableHead>Stage</TableHead>
          <TableHead>Agent</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Trigger</TableHead>
          <TableHead>Duration</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.map((run) => (
          <TableRow key={run.id}>
            <TableCell className="text-muted-foreground">
              {run.startedAt.toLocaleString()}
            </TableCell>
            <TableCell>{run.stageId}</TableCell>
            <TableCell>{run.agentId ?? '—'}</TableCell>
            <TableCell>
              <Badge variant={run.status === 'pass' ? 'success' : run.status === 'fail' ? 'destructive' : 'secondary'}>
                {run.status}
              </Badge>
            </TableCell>
            <TableCell>{run.trigger}</TableCell>
            <TableCell>{run.durationMs != null ? `${run.durationMs}ms` : '—'}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
