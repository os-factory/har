'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Search } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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

function repoName(repo: RepoRow): string {
  return repo.gitRemote ?? repo.path.split('/').pop() ?? repo.path;
}

export function RepoTable({ repos }: { repos: RepoRow[] }) {
  const [query, setQuery] = useState('');
  const [profile, setProfile] = useState<string | null>(null);

  const profiles = useMemo(
    () => Array.from(new Set(repos.map((r) => r.profile).filter((p): p is string => !!p))).sort(),
    [repos],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return repos.filter((repo) => {
      if (profile && repo.profile !== profile) return false;
      if (!q) return true;
      return (
        repoName(repo).toLowerCase().includes(q) ||
        repo.path.toLowerCase().includes(q) ||
        (repo.gitRemote?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [repos, query, profile]);

  if (repos.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No repositories registered. Run <code className="rounded bg-muted px-1">har env init</code> or{' '}
        <code className="rounded bg-muted px-1">har control register</code>.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            placeholder="Search repositories…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-8"
            aria-label="Search repositories"
          />
        </div>
        {profiles.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant={profile === null ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => setProfile(null)}
            >
              All
            </Button>
            {profiles.map((p) => (
              <Button
                key={p}
                variant={profile === p ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => setProfile(p)}
              >
                {p}
              </Button>
            ))}
          </div>
        )}
      </div>

      {filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground">No repositories match your filters.</p>
      ) : (
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
            {filtered.map((repo) => (
              <TableRow key={repo.id}>
                <TableCell>
                  <Link href={`/repos/${repo.id}`} className="font-medium hover:underline">
                    {repoName(repo)}
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
                  {repo.lastSyncAt ? new Date(repo.lastSyncAt).toLocaleString() : '—'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
