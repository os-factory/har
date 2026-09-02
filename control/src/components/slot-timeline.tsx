'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { type ColumnDef } from '@tanstack/react-table';
import { ChevronDown, ChevronRight, FileDiff } from 'lucide-react';
import { DataTable } from '@/components/data-table/data-table';
import { ChangeBatchDiff } from '@/components/change-batch-diff';
import type { ChangeBatchRow } from '@/components/columns/change-batch-columns';
import type { SessionEventRow } from '@/components/columns/session-event-columns';
import { SessionEventsTable } from '@/components/session-events-table';
import { TrajectoryPane } from '@/components/trajectory-pane';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Label } from '@/components/ui/label';
import { formatAgentToolLabel } from '@/lib/agent-tool';
import {
  TIMELINE_KIND_LABEL,
  describeTimeline,
  formatTokenCount,
  summarizeTimeline,
  type TimelineKind,
  type TimelineRow,
  type TimelineTone,
} from '@/lib/slot-timeline';
import { formatModelId } from '@/lib/usage-models';
import { formatDurationMs } from '@/lib/work-unit-state';

const KIND_ORDER: TimelineKind[] = ['occupancy', 'session', 'run', 'snapshot', 'commit'];

function toneVariant(tone: TimelineTone): 'success' | 'destructive' | 'warning' | 'secondary' {
  if (tone === 'pass') return 'success';
  if (tone === 'fail') return 'destructive';
  if (tone === 'warn') return 'warning';
  return 'secondary';
}

function kindClass(kind: TimelineKind): string {
  switch (kind) {
    case 'session':
      return 'border-sky-500/40 text-sky-700 dark:text-sky-300';
    case 'run':
      return 'border-violet-500/40 text-violet-700 dark:text-violet-300';
    case 'snapshot':
      return 'border-amber-500/40 text-amber-800 dark:text-amber-300';
    case 'commit':
      return 'border-emerald-500/40 text-emerald-700 dark:text-emerald-300';
    default:
      return 'text-muted-foreground';
  }
}

function formatWhen(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  return { date: d.toLocaleDateString(), time: d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) };
}

function buildColumns(repositoryId: string, showSlot: boolean, expandedId: string | null): ColumnDef<TimelineRow>[] {
  const columns: ColumnDef<TimelineRow>[] = [
    {
      id: 'expander',
      header: '',
      enableSorting: false,
      cell: ({ row }) => (
        <span className="text-muted-foreground" aria-hidden>
          {expandedId === row.original.id ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        </span>
      ),
    },
    {
      accessorKey: 'at',
      header: 'Time',
      cell: ({ row }) => {
        const { date, time } = formatWhen(row.original.at);
        return (
          <time dateTime={row.original.at} className="whitespace-nowrap tabular-nums text-xs" suppressHydrationWarning>
            <span className="text-muted-foreground">{date}</span> {time}
          </time>
        );
      },
    },
    {
      accessorKey: 'kind',
      header: 'Kind',
      cell: ({ row }) => (
        <Badge variant="outline" className={kindClass(row.original.kind)}>
          {TIMELINE_KIND_LABEL[row.original.kind]}
        </Badge>
      ),
    },
    {
      accessorKey: 'title',
      header: 'Event',
      cell: ({ row }) => (
        <div className="min-w-0 max-w-[36rem]">
          <p className="truncate text-sm font-medium" title={row.original.title}>{row.original.title}</p>
          {row.original.detail ? (
            <p className="truncate text-xs text-muted-foreground" title={row.original.detail}>{row.original.detail}</p>
          ) : null}
        </div>
      ),
    },
    {
      accessorKey: 'status',
      header: 'Status',
      cell: ({ row }) => {
        const { status, tone, kind } = row.original;
        if (!status) return <span className="text-muted-foreground">—</span>;
        if (kind === 'session') return <Badge variant="outline">{formatAgentToolLabel(status)}</Badge>;
        return <Badge variant={toneVariant(tone)}>{status}</Badge>;
      },
    },
  ];
  if (showSlot) {
    columns.push({
      accessorKey: 'agentId',
      header: 'Slot',
      cell: ({ row }) =>
        row.original.agentId == null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <Link
            href={`/repos/${repositoryId}/slots/${row.original.agentId}`}
            className="text-primary underline-offset-2 hover:underline"
          >
            Slot {row.original.agentId}
          </Link>
        ),
    });
  }
  return columns;
}

function Field({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className={mono ? 'break-all font-mono text-xs' : 'text-sm'}>{value}</dd>
    </div>
  );
}

function RunDetail({ row }: { row: TimelineRow }) {
  const run = row.run!;
  return (
    <div className="space-y-3" data-testid="timeline-run-detail">
      <dl className="grid gap-3 sm:grid-cols-4">
        <Field label="Result" value={<Badge variant={toneVariant(row.tone)}>{row.status}</Badge>} />
        <Field label="Duration" value={run.durationMs != null ? formatDurationMs(run.durationMs) : '—'} />
        <Field label="Trigger" value={run.trigger} />
        <Field label="Run id" value={run.runId} mono />
      </dl>
      {run.stages.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5" aria-label="Stage results">
          {run.stages.map((stage) => (
            <li key={stage.name}>
              <Badge variant={stage.pass ? 'success' : 'destructive'} className="gap-1 font-mono text-[11px]">
                {stage.pass ? '✓' : '✗'} {stage.name}
                {stage.ms != null ? <span className="opacity-70">{formatDurationMs(stage.ms)}</span> : null}
              </Badge>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">This run did not record per-stage results.</p>
      )}
    </div>
  );
}

function SnapshotDetail({ row, repositoryId, onOpenDiff }: { row: TimelineRow; repositoryId: string; onOpenDiff: (row: TimelineRow) => void }) {
  const snapshot = row.snapshot!;
  const files = snapshot.changedFiles;
  return (
    <div className="space-y-3" data-testid="timeline-snapshot-detail">
      <dl className="grid gap-3 sm:grid-cols-4">
        <Field label="Verdict" value={<Badge variant={toneVariant(row.tone)}>{row.status}</Badge>} />
        <Field label="Tree hash" value={snapshot.treeHash} mono />
        <Field label="Branch" value={snapshot.branch ?? '—'} mono />
        <Field
          label="Commit"
          value={snapshot.commitSha ? snapshot.commitSha.slice(0, 7) : 'not committed'}
          mono
        />
      </dl>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => onOpenDiff(row)} disabled={files.length === 0}>
          <FileDiff className="mr-1.5 size-3.5" />
          Open diff
        </Button>
        {snapshot.runId ? (
          <span className="text-xs text-muted-foreground">
            verified by run <code className="font-mono">{snapshot.runId}</code>
          </span>
        ) : null}
        <Link href={`/repos/${repositoryId}?tab=history`} className="text-xs text-primary underline-offset-2 hover:underline">
          Show in repository history
        </Link>
      </div>
      {files.length > 0 ? (
        <ul className="max-h-48 overflow-auto rounded-md border bg-background/60 p-2 font-mono text-xs">
          {files.map((file) => (
            <li key={`${file.status}:${file.path}`} className="flex gap-2">
              <span className="w-4 shrink-0 text-muted-foreground">{file.status}</span>
              <span className="truncate">{file.path}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">No changed files were recorded for this snapshot.</p>
      )}
    </div>
  );
}

function CommitDetail({ row }: { row: TimelineRow }) {
  const commit = row.commit!;
  return (
    <div className="space-y-3" data-testid="timeline-commit-detail">
      <dl className="grid gap-3 sm:grid-cols-3">
        <Field label="Commit" value={commit.sha} mono />
        <Field label="Tree hash" value={commit.treeHash} mono />
        <Field label="Branch" value={commit.branch ?? (commit.refs[0] ?? '—')} mono />
      </dl>
      {commit.message ? (
        <pre className="whitespace-pre-wrap rounded-md border bg-background/60 p-2 text-xs">{commit.message}</pre>
      ) : (
        <p className="text-xs text-muted-foreground">The commit message was not synced. The commit is bound to a verified tree snapshot.</p>
      )}
    </div>
  );
}

function OccupancyDetail({ row }: { row: TimelineRow }) {
  const occupancy = row.occupancy!;
  return (
    <dl className="grid gap-3 sm:grid-cols-4" data-testid="timeline-occupancy-detail">
      <Field label="Branch" value={occupancy.branch ?? '—'} mono />
      <Field label="Base commit" value={occupancy.baseCommit ?? '—'} mono />
      <Field label="Worktree" value={occupancy.worktreePath ?? '—'} mono />
      <Field label="Attempt" value={occupancy.attemptId ?? '—'} mono />
    </dl>
  );
}

function SessionDetail({ row, repositoryId }: { row: TimelineRow; repositoryId: string }) {
  const session = row.session!;
  return (
    <div className="space-y-3" data-testid="timeline-session-detail">
      <dl className="grid gap-3 sm:grid-cols-5">
        <Field label="Agent" value={formatAgentToolLabel(session.agentTool)} />
        <Field
          label="Models"
          value={session.models.length > 0 ? session.models.map(formatModelId).join(', ') : '—'}
        />
        <Field label="Duration" value={session.durationMs != null ? formatDurationMs(session.durationMs) : '—'} />
        <Field label="Tokens" value={formatTokenCount(session.tokensTotal)} />
        <Field label="Cost" value={session.costUsd != null ? `$${session.costUsd.toFixed(4)}` : '—'} />
      </dl>
      <p className="font-mono text-[11px] text-muted-foreground">
        session {session.sessionKey}
        {session.sources.length > 0 ? ` · ${session.sources.join(', ')}` : ''}
      </p>
      {row.agentId != null ? (
        <TrajectoryPane
          repositoryId={repositoryId}
          agentId={row.agentId}
          sessionKey={session.sessionKey}
          agentTool={session.agentTool}
        />
      ) : null}
    </div>
  );
}

function toChangeBatchRow(row: TimelineRow): ChangeBatchRow {
  const snapshot = row.snapshot!;
  return {
    id: snapshot.validationId,
    treeHash: snapshot.treeHash,
    branch: snapshot.branch,
    agentId: row.agentId,
    status: snapshot.status,
    full: snapshot.full,
    runId: snapshot.runId,
    changedFiles: snapshot.changedFiles,
    commitSha: snapshot.commitSha,
    createdAt: new Date(row.at),
  };
}

export interface SlotTimelineProps {
  repositoryId: string;
  rows: TimelineRow[];
  /** Events from earlier occupants of the same slot number; rendered collapsed. */
  previousRows?: TimelineRow[];
  previousLabel?: string;
  /** Raw OTEL events, offered behind a debug toggle. */
  rawEvents?: SessionEventRow[];
  showSlotColumn?: boolean;
  emptyMessage?: string;
  searchPlaceholder?: string;
  /** Row opened on first render, e.g. the newest agent session so its trajectory is visible without a click. */
  defaultExpandedId?: string | null;
}

export function SlotTimeline({
  repositoryId,
  rows,
  previousRows = [],
  previousLabel = 'Earlier occupants of this slot',
  rawEvents,
  showSlotColumn = false,
  emptyMessage = 'Nothing recorded yet. Runs, snapshots, commits and agent sessions appear here as they happen.',
  searchPlaceholder = 'Search timeline…',
  defaultExpandedId = null,
}: SlotTimelineProps) {
  const [expandedId, setExpandedId] = useState<string | null>(defaultExpandedId);
  const [previousExpandedId, setPreviousExpandedId] = useState<string | null>(null);
  const [kinds, setKinds] = useState<Set<TimelineKind>>(() => new Set(KIND_ORDER));
  const [diffRow, setDiffRow] = useState<TimelineRow | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [previousOpen, setPreviousOpen] = useState(false);

  const visible = useMemo(() => rows.filter((row) => kinds.has(row.kind)), [rows, kinds]);
  const columns = useMemo(() => buildColumns(repositoryId, showSlotColumn, expandedId), [repositoryId, showSlotColumn, expandedId]);
  const previousColumns = useMemo(
    () => buildColumns(repositoryId, showSlotColumn, previousExpandedId),
    [repositoryId, showSlotColumn, previousExpandedId],
  );
  const totals = useMemo(() => summarizeTimeline(rows), [rows]);
  const presentKinds = useMemo(() => KIND_ORDER.filter((kind) => rows.some((row) => row.kind === kind)), [rows]);

  const renderExpanded = (row: TimelineRow) => {
    switch (row.kind) {
      case 'run':
        return <RunDetail row={row} />;
      case 'snapshot':
        return <SnapshotDetail row={row} repositoryId={repositoryId} onOpenDiff={setDiffRow} />;
      case 'commit':
        return <CommitDetail row={row} />;
      case 'occupancy':
        return <OccupancyDetail row={row} />;
      case 'session':
        return <SessionDetail row={row} repositoryId={repositoryId} />;
      default:
        return null;
    }
  };

  const toggleKind = (kind: TimelineKind) => {
    setKinds((current) => {
      const next = new Set(current);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  };

  return (
    <div className="space-y-4" data-testid="slot-timeline">
      <p className="text-xs text-muted-foreground" data-testid="slot-timeline-summary">{describeTimeline(totals)}</p>

      <DataTable
        columns={columns}
        data={visible}
        getRowId={(row) => row.id}
        showPagination={false}
        maxBodyHeight="60vh"
        searchPlaceholder={searchPlaceholder}
        searchAriaLabel="Search timeline"
        emptyMessage={rows.length === 0 ? emptyMessage : 'No events match the current filters.'}
        onRowClick={(row) => setExpandedId((current) => (current === row.id ? null : row.id))}
        expandedRowId={expandedId}
        renderExpanded={renderExpanded}
        toolbarExtra={
          <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Filter by kind">
            {presentKinds.map((kind) => (
              <Button
                key={kind}
                type="button"
                size="sm"
                variant={kinds.has(kind) ? 'secondary' : 'ghost'}
                aria-pressed={kinds.has(kind)}
                onClick={() => toggleKind(kind)}
                className="h-7 px-2 text-xs"
              >
                {TIMELINE_KIND_LABEL[kind]}
              </Button>
            ))}
          </div>
        }
      />

      {previousRows.length > 0 ? (
        <Collapsible open={previousOpen} onOpenChange={setPreviousOpen}>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="h-8 px-2 text-xs text-muted-foreground" data-testid="timeline-previous-toggle">
              {previousOpen ? <ChevronDown className="mr-1 size-3.5" /> : <ChevronRight className="mr-1 size-3.5" />}
              {previousLabel} ({previousRows.length})
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2">
            <DataTable
              columns={previousColumns}
              data={previousRows}
              getRowId={(row) => row.id}
              showPagination={false}
              showToolbar={false}
              maxBodyHeight="40vh"
              onRowClick={(row) => setPreviousExpandedId((current) => (current === row.id ? null : row.id))}
              expandedRowId={previousExpandedId}
              renderExpanded={renderExpanded}
            />
          </CollapsibleContent>
        </Collapsible>
      ) : null}

      {rawEvents ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Checkbox id="timeline-raw-events" checked={showRaw} onCheckedChange={(value) => setShowRaw(value === true)} />
            <Label htmlFor="timeline-raw-events" className="text-xs text-muted-foreground">
              Show raw OTEL events (debug)
            </Label>
          </div>
          {showRaw ? <SessionEventsTable events={rawEvents} /> : null}
        </div>
      ) : null}

      <ChangeBatchDiff
        repoId={repositoryId}
        batch={diffRow ? toChangeBatchRow(diffRow) : null}
        open={diffRow != null}
        onOpenChange={(open) => {
          if (!open) setDiffRow(null);
        }}
      />
    </div>
  );
}
