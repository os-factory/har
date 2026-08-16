'use client';

import { useMemo, useState } from 'react';
import { DataTable } from '@/components/data-table/data-table';
import {
  sessionEventColumns,
  type SessionEventRow,
} from '@/components/columns/session-event-columns';
import { SessionEventPreview } from '@/components/session-event-preview';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  countSessionEventViews,
  isStartEndBoundaryEvent,
  matchesSessionEventView,
  SESSION_EVENT_VIEWS,
  type SessionEventView,
} from '@/lib/session-event-detail';

export function SessionEventsTable({ events }: { events: SessionEventRow[] }) {
  const [view, setView] = useState<SessionEventView>('activity');
  const [hideStartEnd, setHideStartEnd] = useState(true);
  const [selected, setSelected] = useState<SessionEventRow | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  const scoped = useMemo(
    () => hideStartEnd
      ? events.filter((event) => !isStartEndBoundaryEvent(event.eventName))
      : events,
    [events, hideStartEnd],
  );
  const counts = useMemo(() => countSessionEventViews(scoped), [scoped]);

  const visible = useMemo(
    () => scoped.filter((event) => matchesSessionEventView(event, view)),
    [scoped, view],
  );

  if (events.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No OTEL session events yet. Enable telemetry (`har telemetry on`) and run an agent in this
        slot&apos;s worktree.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <ToggleGroup
          type="single"
          size="sm"
          variant="outline"
          value={view}
          onValueChange={(value) => {
            if (value) setView(value as SessionEventView);
          }}
          className="flex flex-wrap justify-start gap-1"
          aria-label="Filter session events"
        >
          {SESSION_EVENT_VIEWS.map((entry) => (
            <ToggleGroupItem
              key={entry.id}
              value={entry.id}
              aria-label={`${entry.label} (${counts[entry.id]})`}
              className="px-2.5 text-xs"
            >
              {entry.label}
              <span className="ml-1 tabular-nums text-muted-foreground">{counts[entry.id]}</span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <Checkbox
              id="hide-start-end"
              checked={hideStartEnd}
              onCheckedChange={(value) => setHideStartEnd(value === true)}
              aria-label="Hide start/end events"
            />
            <Label htmlFor="hide-start-end" className="text-xs font-normal text-muted-foreground">
              Hide start/end events
            </Label>
          </div>
          <p className="text-xs text-muted-foreground">
            Showing {visible.length} of {scoped.length}
            {hideStartEnd && scoped.length !== events.length ? ` (${events.length - scoped.length} hidden)` : ''}.
            {' '}Click a row for attributes.
          </p>
        </div>
      </div>

      <DataTable
        columns={sessionEventColumns}
        data={visible}
        getRowId={(row) => row.id}
        showPagination={visible.length > 15}
        pageSize={15}
        searchPlaceholder="Search type, tool, command, file…"
        searchAriaLabel="Search session events"
        emptyMessage="No events in this view — try another filter."
        onRowClick={(row) => {
          setSelected(row);
          setPreviewOpen(true);
        }}
        getRowClassName={(row) =>
          /Failure|Error/i.test(row.eventName) ? 'bg-destructive/5' : undefined
        }
      />

      <SessionEventPreview
        event={selected}
        open={previewOpen}
        onOpenChange={setPreviewOpen}
      />
    </div>
  );
}
