'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { FileDiff, GripVertical, LoaderCircle } from 'lucide-react';
import type { ChangeBatchRow } from '@/components/columns/change-batch-columns';
import { DiffFileTree } from '@/components/diff-file-tree';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { parseUnifiedDiff, type DiffFile, type DiffLine } from '@/lib/unified-diff';

interface ChangeBatchDiffProps {
  repoId: string;
  batch: ChangeBatchRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function lineClass(kind: DiffLine['kind']) {
  switch (kind) {
    case 'add':
      return 'bg-emerald-500/10 text-emerald-950 dark:text-emerald-100';
    case 'delete':
      return 'bg-rose-500/10 text-rose-950 dark:text-rose-100';
    case 'meta':
      return 'bg-muted/60 text-muted-foreground';
    default:
      return 'text-foreground';
  }
}

function linePrefix(kind: DiffLine['kind']) {
  if (kind === 'add') return '+';
  if (kind === 'delete') return '−';
  return ' ';
}

function DiffLineRow({ line }: { line: DiffLine }) {
  if (line.kind === 'meta') {
    return (
      <div className={cn('px-4 py-1 font-mono text-xs', lineClass(line.kind))}>{line.content}</div>
    );
  }

  return (
    <div className={cn('grid grid-cols-[3rem_3rem_1.5rem_minmax(0,1fr)] font-mono text-xs leading-5', lineClass(line.kind))}>
      <span className="select-none border-r border-current/10 px-2 text-right text-muted-foreground">
        {line.oldLine ?? ''}
      </span>
      <span className="select-none border-r border-current/10 px-2 text-right text-muted-foreground">
        {line.newLine ?? ''}
      </span>
      <span className="select-none text-center">{linePrefix(line.kind)}</span>
      <code className="min-w-0 whitespace-pre px-2">{line.content}</code>
    </div>
  );
}

function FileDiffView({ file }: { file: DiffFile }) {
  return (
    <div className="min-w-0 overflow-x-auto rounded-md border bg-background">
      <div className="sticky top-0 z-10 border-b bg-muted/80 px-4 py-2 font-mono text-xs font-medium backdrop-blur">
        {file.path}
        {file.oldPath && file.oldPath !== file.path && (
          <span className="ml-2 text-muted-foreground">renamed from {file.oldPath}</span>
        )}
      </div>
      <div className="min-w-max">
        {file.lines.map((line, index) => (
          <DiffLineRow key={`${line.kind}-${index}`} line={line} />
        ))}
      </div>
    </div>
  );
}

export function ChangeBatchDiff({ repoId, batch, open, onOpenChange }: ChangeBatchDiffProps) {
  const [diff, setDiff] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string>();
  const [sheetWidth, setSheetWidth] = useState(1100);
  const [treeWidth, setTreeWidth] = useState(208);
  const [resizing, setResizing] = useState<'sheet' | 'tree' | null>(null);
  const diffScrollRef = useRef<HTMLDivElement>(null);
  const splitPaneRef = useRef<HTMLDivElement>(null);
  const fileSectionRefs = useRef(new Map<string, HTMLDivElement>());
  const files = useMemo(() => parseUnifiedDiff(diff), [diff]);
  const selectedFile = files.find((file) => file.path === selectedPath) ?? files[0];
  const selectFile = (path: string) => {
    setSelectedPath(path);
    fileSectionRefs.current.get(path)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const updateActiveFileOnScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const scrollPosition = event.currentTarget.scrollTop + 16;
    let activeFile = files[0];

    for (const file of files) {
      const section = fileSectionRefs.current.get(file.path);
      if (section && section.offsetTop <= scrollPosition) activeFile = file;
      else break;
    }

    if (activeFile && activeFile.path !== selectedFile?.path) {
      setSelectedPath(activeFile.path);
    }
  };

  useEffect(() => {
    if (!open || !batch) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDiff('');
    setTruncated(false);
    setSelectedPath(undefined);

    fetch(`/api/repos/${encodeURIComponent(repoId)}/changes/${encodeURIComponent(batch.id)}`)
      .then(async (response) => {
        const payload = (await response.json()) as { diff?: string; error?: string; truncated?: boolean };
        if (!response.ok) throw new Error(payload.error ?? 'Unable to load diff');
        return payload;
      })
      .then((payload) => {
        if (cancelled) return;
        setDiff(payload.diff ?? '');
        setTruncated(payload.truncated ?? false);
      })
      .catch((fetchError: unknown) => {
        if (!cancelled) setError(fetchError instanceof Error ? fetchError.message : 'Unable to load diff');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [batch, open, repoId]);

  useEffect(() => {
    if (!resizing) return;

    const onPointerMove = (event: PointerEvent) => {
      if (resizing === 'sheet') {
        const maxWidth = Math.min(window.innerWidth * 0.96, 1600);
        setSheetWidth(Math.max(720, Math.min(maxWidth, window.innerWidth - event.clientX)));
        return;
      }

      const bounds = splitPaneRef.current?.getBoundingClientRect();
      if (!bounds) return;
      const maxTreeWidth = Math.max(180, Math.min(480, bounds.width - 360));
      setTreeWidth(Math.max(180, Math.min(maxTreeWidth, event.clientX - bounds.left)));
    };
    const stopResizing = () => setResizing(null);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', stopResizing);
    return () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', stopResizing);
    };
  }, [resizing]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex min-h-0 w-full flex-col gap-4 p-6 sm:max-w-[min(96vw,1200px)]"
        style={{ width: `${sheetWidth}px`, maxWidth: '96vw' }}
      >
        <button
          type="button"
          aria-label="Resize diff drawer"
          onPointerDown={() => setResizing('sheet')}
          className="absolute inset-y-0 left-0 z-20 w-2 cursor-col-resize touch-none bg-transparent transition-colors hover:bg-primary/20 focus-visible:bg-primary/20 focus-visible:outline-none"
        />
        {batch && (
          <>
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2 pr-8">
                <FileDiff className="h-5 w-5 text-primary" />
                Change batch <span className="font-mono text-base">{batch.treeHash.slice(0, 8)}</span>
              </SheetTitle>
              <SheetDescription>
                {batch.branch ?? 'Detached HEAD'} · {batch.changedFiles.length} changed file
                {batch.changedFiles.length === 1 ? '' : 's'} · {batch.createdAt.toLocaleString()}
              </SheetDescription>
            </SheetHeader>

            {loading && (
              <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
                <LoaderCircle className="h-4 w-4 animate-spin" />
                Loading diff…
              </div>
            )}
            {error && <p className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">{error}</p>}
            {truncated && (
              <p className="rounded-md border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-950 dark:text-amber-100">
                This diff exceeds the 1 MB viewer limit. Use Git locally to inspect the full patch.
              </p>
            )}
            {!loading && !error && !truncated && files.length === 0 && (
              <p className="rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground">
                No textual patch was produced. This batch may only contain binary or mode changes.
              </p>
            )}
            {!loading && !error && !truncated && files.length > 0 && (
              <div
                ref={splitPaneRef}
                className="grid min-h-0 flex-1 overflow-hidden rounded-md border"
                style={{ gridTemplateColumns: `${treeWidth}px 9px minmax(0, 1fr)` }}
              >
                <nav
                  className="h-full min-h-0 overflow-auto overscroll-contain border-r bg-muted/30 p-2"
                  aria-label="Changed files"
                >
                  <DiffFileTree
                    files={files}
                    selectedPath={selectedFile?.path}
                    onSelect={selectFile}
                  />
                </nav>
                <button
                  type="button"
                  aria-label="Resize file tree"
                  onPointerDown={() => setResizing('tree')}
                  className="group relative z-10 flex cursor-col-resize touch-none items-center justify-center bg-muted/30 hover:bg-primary/10 focus-visible:bg-primary/10 focus-visible:outline-none"
                >
                  <GripVertical className="h-3.5 w-3.5 text-muted-foreground transition-colors group-hover:text-primary" />
                </button>
                <div
                  ref={diffScrollRef}
                  onScroll={updateActiveFileOnScroll}
                  className="h-full min-h-0 min-w-0 overflow-auto overscroll-contain bg-muted/10 p-3"
                >
                  <div className="space-y-3">
                    {files.map((file) => (
                      <div
                        key={file.path}
                        ref={(element) => {
                          if (element) fileSectionRefs.current.set(file.path, element);
                          else fileSectionRefs.current.delete(file.path);
                        }}
                      >
                        <FileDiffView file={file} />
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
