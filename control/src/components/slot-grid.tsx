import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

export interface SlotRow {
  slotId: number;
  active: boolean;
  workDir: string | null;
  worktreePath: string | null;
  harnessUsage: string;
  lastRunAt: Date | null;
  lastVerifyStatus: string | null;
  lastBuildPass: boolean | null;
}

function usageBadge(usage: string) {
  switch (usage) {
    case 'mcp':
      return <Badge variant="success">MCP</Badge>;
    case 'cli':
      return <Badge variant="default">CLI</Badge>;
    case 'script':
      return <Badge variant="secondary">Script</Badge>;
    case 'bypass_warning':
      return <Badge variant="warning">Bypass?</Badge>;
    default:
      return <Badge variant="outline">None</Badge>;
  }
}

export function SlotGrid({ slots }: { slots: SlotRow[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Slot</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Worktree</TableHead>
          <TableHead>Harness</TableHead>
          <TableHead>Last verify</TableHead>
          <TableHead>Build</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {slots.map((slot) => (
          <TableRow key={slot.slotId}>
            <TableCell className="font-medium">{slot.slotId}</TableCell>
            <TableCell>{slot.active ? '● Active' : '○ Idle'}</TableCell>
            <TableCell className="max-w-xs truncate text-muted-foreground">
              {slot.worktreePath ?? slot.workDir ?? '—'}
            </TableCell>
            <TableCell>{usageBadge(slot.harnessUsage)}</TableCell>
            <TableCell>
              {slot.lastVerifyStatus ? (
                <Badge variant={slot.lastVerifyStatus === 'pass' ? 'success' : 'destructive'}>
                  {slot.lastVerifyStatus}
                </Badge>
              ) : (
                '—'
              )}
            </TableCell>
            <TableCell>
              {slot.lastBuildPass === true && <Badge variant="success">pass</Badge>}
              {slot.lastBuildPass === false && <Badge variant="destructive">fail</Badge>}
              {slot.lastBuildPass == null && '—'}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
