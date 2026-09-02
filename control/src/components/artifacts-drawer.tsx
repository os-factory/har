'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { ArtifactTable } from '@/components/artifact-table';
import type { ArtifactRow } from '@/components/columns/artifact-columns';

export function ArtifactsDrawer({ repoId, artifacts }: { repoId: string; artifacts: ArtifactRow[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)} data-testid="artifacts-drawer-button">
        Artifacts <span className="ml-1 tabular-nums text-muted-foreground">{artifacts.length}</span>
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle>Artifacts</SheetTitle>
            <SheetDescription>Files the harness wrote under .har/artifacts, newest first.</SheetDescription>
          </SheetHeader>
          <div className="mt-4">
            <ArtifactTable repoId={repoId} artifacts={artifacts} />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
