import { FolderGit2Icon, ServerIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import type { RepoRow } from '@/components/columns/repo-columns';

export function RepoSectionCards({ repos }: { repos: RepoRow[] }) {
  const visible = repos.filter((repo) => !repo.hidden);
  const activeSlots = visible.reduce((total, repo) => total + repo.slotCount, 0);

  return (
    <div className="grid grid-cols-2 gap-4 px-4 lg:px-6 *:data-[slot=card]:shadow-xs *:data-[slot=card]:bg-gradient-to-t *:data-[slot=card]:from-primary/5 *:data-[slot=card]:to-card dark:*:data-[slot=card]:bg-card">
      <Card className="@container/card">
        <CardHeader className="relative">
          <CardDescription>Repositories</CardDescription>
          <CardTitle className="@[250px]/card:text-3xl text-2xl font-semibold tabular-nums">
            {visible.length}
          </CardTitle>
          <div className="absolute right-4 top-4">
            <Badge variant="outline" className="flex gap-1 rounded-lg text-xs">
              <FolderGit2Icon className="size-3" />
              Registered
            </Badge>
          </div>
        </CardHeader>
        <CardFooter className="flex-col items-start gap-1 text-sm">
          <div className="line-clamp-1 flex gap-2 font-medium">Harness projects on this machine</div>
          <div className="text-muted-foreground">
            {repos.length - visible.length > 0
              ? `${repos.length - visible.length} hidden (temporary or missing paths)`
              : 'Register more with har control register'}
          </div>
        </CardFooter>
      </Card>
      <Card className="@container/card">
        <CardHeader className="relative">
          <CardDescription>Agent slots</CardDescription>
          <CardTitle className="@[250px]/card:text-3xl text-2xl font-semibold tabular-nums">
            {activeSlots}
          </CardTitle>
          <div className="absolute right-4 top-4">
            <Badge variant="outline" className="flex gap-1 rounded-lg text-xs">
              <ServerIcon className="size-3" />
              Synced
            </Badge>
          </div>
        </CardHeader>
        <CardFooter className="flex-col items-start gap-1 text-sm">
          <div className="line-clamp-1 flex gap-2 font-medium">Worktrees and preview URLs</div>
          <div className="text-muted-foreground">One slot per agent environment</div>
        </CardFooter>
      </Card>
    </div>
  );
}
