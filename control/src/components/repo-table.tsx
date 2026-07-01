import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

export interface RepoRow {
  id: string;
  path: string;
  gitRemote: string | null;
  lastSyncAt: Date | null;
  runCount: number;
  slotCount: number;
  profile?: string;
}

export function RepoTable({ repos }: { repos: RepoRow[] }) {
  if (repos.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No repositories registered. Run <code className="rounded bg-muted px-1">har env init</code> or{' '}
        <code className="rounded bg-muted px-1">har control register</code>.
      </p>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Repository</TableHead>
          <TableHead>Path</TableHead>
          <TableHead>Runs</TableHead>
          <TableHead>Slots</TableHead>
          <TableHead>Last sync</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {repos.map((repo) => (
          <TableRow key={repo.id}>
            <TableCell>
              <Link href={`/repos/${repo.id}`} className="font-medium hover:underline">
                {repo.gitRemote ?? repo.path.split('/').pop()}
              </Link>
              {repo.profile && (
                <Badge variant="secondary" className="ml-2">
                  {repo.profile}
                </Badge>
              )}
            </TableCell>
            <TableCell className="max-w-md truncate text-muted-foreground">{repo.path}</TableCell>
            <TableCell>{repo.runCount}</TableCell>
            <TableCell>{repo.slotCount}</TableCell>
            <TableCell className="text-muted-foreground">
              {repo.lastSyncAt ? repo.lastSyncAt.toLocaleString() : '—'}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
