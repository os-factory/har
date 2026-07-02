import { FolderGit2Icon, PlayCircleIcon, ServerIcon, TagsIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import type { RepoRow } from '@/components/columns/repo-columns';

function sum(repos: RepoRow[], key: keyof Pick<RepoRow, 'runCount' | 'slotCount'>) {
  return repos.reduce((total, repo) => total + repo[key], 0);
}

export function RepoSectionCards({ repos }: { repos: RepoRow[] }) {
  const totalRuns = sum(repos, 'runCount');
  const totalSlots = sum(repos, 'slotCount');
  const profiles = new Set(repos.map((repo) => repo.profile).filter(Boolean));

  return (
    <div className="grid grid-cols-2 gap-4 px-4 lg:px-6 xl:grid-cols-4 *:data-[slot=card]:shadow-xs *:data-[slot=card]:bg-gradient-to-t *:data-[slot=card]:from-primary/5 *:data-[slot=card]:to-card dark:*:data-[slot=card]:bg-card">
      <Card className="@container/card">
        <CardHeader className="relative">
          <CardDescription>Repositories</CardDescription>
          <CardTitle className="@[250px]/card:text-3xl text-2xl font-semibold tabular-nums">
            {repos.length}
          </CardTitle>
          <div className="absolute right-4 top-4">
            <Badge variant="outline" className="flex gap-1 rounded-lg text-xs">
              <FolderGit2Icon className="size-3" />
              Registered
            </Badge>
          </div>
        </CardHeader>
        <CardFooter className="flex-col items-start gap-1 text-sm">
          <div className="line-clamp-1 flex gap-2 font-medium">
            Harness projects on this machine
          </div>
          <div className="text-muted-foreground">
            Start with <code className="rounded bg-muted px-1">har control up</code>
          </div>
        </CardFooter>
      </Card>
      <Card className="@container/card">
        <CardHeader className="relative">
          <CardDescription>Total runs</CardDescription>
          <CardTitle className="@[250px]/card:text-3xl text-2xl font-semibold tabular-nums">
            {totalRuns}
          </CardTitle>
          <div className="absolute right-4 top-4">
            <Badge variant="outline" className="flex gap-1 rounded-lg text-xs">
              <PlayCircleIcon className="size-3" />
              Synced
            </Badge>
          </div>
        </CardHeader>
        <CardFooter className="flex-col items-start gap-1 text-sm">
          <div className="line-clamp-1 flex gap-2 font-medium">Across all repositories</div>
          <div className="text-muted-foreground">Launch, verify, and teardown history</div>
        </CardFooter>
      </Card>
      <Card className="@container/card">
        <CardHeader className="relative">
          <CardDescription>Agent slots</CardDescription>
          <CardTitle className="@[250px]/card:text-3xl text-2xl font-semibold tabular-nums">
            {totalSlots}
          </CardTitle>
          <div className="absolute right-4 top-4">
            <Badge variant="outline" className="flex gap-1 rounded-lg text-xs">
              <ServerIcon className="size-3" />
              Active
            </Badge>
          </div>
        </CardHeader>
        <CardFooter className="flex-col items-start gap-1 text-sm">
          <div className="line-clamp-1 flex gap-2 font-medium">Worktrees and preview URLs</div>
          <div className="text-muted-foreground">One slot per agent environment</div>
        </CardFooter>
      </Card>
      <Card className="@container/card">
        <CardHeader className="relative">
          <CardDescription>Profiles</CardDescription>
          <CardTitle className="@[250px]/card:text-3xl text-2xl font-semibold tabular-nums">
            {profiles.size || '—'}
          </CardTitle>
          <div className="absolute right-4 top-4">
            <Badge variant="outline" className="flex gap-1 rounded-lg text-xs">
              <TagsIcon className="size-3" />
              Manifest
            </Badge>
          </div>
        </CardHeader>
        <CardFooter className="flex-col items-start gap-1 text-sm">
          <div className="line-clamp-1 flex gap-2 font-medium">Distinct harness profiles</div>
          <div className="text-muted-foreground">From each repo manifest</div>
        </CardFooter>
      </Card>
    </div>
  );
}
