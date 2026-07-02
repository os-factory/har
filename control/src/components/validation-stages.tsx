import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { ValidationStageStatus } from '@/server/validation-stages';

function stageBadge(stage: ValidationStageStatus) {
  if (stage.lastStatus === 'pass') {
    return <Badge variant="success">Passed</Badge>;
  }
  if (stage.lastStatus === 'fail') {
    return <Badge variant="destructive">Failed</Badge>;
  }
  return <Badge variant="secondary">Not run</Badge>;
}

function passRate(stage: ValidationStageStatus): string {
  if (stage.runCount === 0) return '—';
  return `${stage.passCount}/${stage.runCount}`;
}

function duration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

export function ValidationStages({ stages }: { stages: ValidationStageStatus[] }) {
  if (stages.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No validation stages declared. Add `verificationStages` to `.har/stages.json` and re-sync
        the repository.
      </p>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-8">#</TableHead>
          <TableHead>Stage</TableHead>
          <TableHead>Last result</TableHead>
          <TableHead>Duration</TableHead>
          <TableHead>Pass rate</TableHead>
          <TableHead>Last run</TableHead>
          <TableHead>Agent</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {stages.map((stage, index) => (
          <TableRow key={stage.name}>
            <TableCell className="text-muted-foreground">
              {stage.declared ? index + 1 : '—'}
            </TableCell>
            <TableCell className="font-mono">
              {stage.name}
              {!stage.declared && (
                <Badge variant="outline" className="ml-2">
                  Undeclared
                </Badge>
              )}
            </TableCell>
            <TableCell title={stage.lastStatus === 'fail' ? (stage.lastOutput ?? undefined) : undefined}>
              {stageBadge(stage)}
            </TableCell>
            <TableCell>{duration(stage.lastMs)}</TableCell>
            <TableCell>{passRate(stage)}</TableCell>
            <TableCell className="text-muted-foreground">
              {stage.lastRunAt ? (
                <span title={stage.lastRunId ?? undefined}>
                  {stage.lastRunAt.toLocaleString()}
                </span>
              ) : (
                '—'
              )}
            </TableCell>
            <TableCell>{stage.lastAgentId ?? '—'}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
