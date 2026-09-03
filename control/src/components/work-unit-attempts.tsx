'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { AttemptRecordView } from '@/components/attempt-record';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { pickDefaultSession } from '@/lib/slot-timeline';
import { timeAgo } from '@/lib/time';
import type { AttemptRecord } from '@/server/attempt-record';

/**
 * Every attempt of a work unit as a record, newest first and open by default (#348).
 * Slot numbers are text: a slot is live data and may hold unrelated work by now.
 */
export function WorkUnitAttempts({ repositoryId, records }: { repositoryId: string; records: AttemptRecord[] }) {
  const [open, setOpen] = useState<Set<string>>(() => new Set(records[0] ? [records[0].occupancyKey] : []));

  if (records.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No attempt synchronized yet. Launch with <code>har env launch &lt;slot&gt; --work-id &lt;id&gt;</code> to bind one.
      </p>
    );
  }

  const toggle = (key: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className="space-y-3" data-testid="work-unit-attempts">
      {records.map((record) => {
        const isOpen = open.has(record.occupancyKey);
        const latest = record.verification?.latestRun ?? null;
        return (
          <Collapsible key={record.occupancyKey} open={isOpen} onOpenChange={() => toggle(record.occupancyKey)}>
            <div className="rounded-xl border">
              <CollapsibleTrigger asChild>
                <Button
                  variant="ghost"
                  className="flex h-auto w-full flex-wrap items-center justify-start gap-x-3 gap-y-1 rounded-xl px-4 py-3 text-left"
                  data-testid="work-unit-attempt-toggle"
                >
                  {isOpen ? <ChevronDown className="size-4 text-muted-foreground" /> : <ChevronRight className="size-4 text-muted-foreground" />}
                  <span className="font-medium">
                    {record.attempt.agentId != null ? `Slot ${record.attempt.agentId}` : 'Attempt'}
                  </span>
                  {record.attempt.branch ? <code className="font-mono text-xs text-muted-foreground">{record.attempt.branch}</code> : null}
                  {record.attempt.startedAt ? (
                    <span className="text-xs text-muted-foreground" suppressHydrationWarning>
                      started {timeAgo(record.attempt.startedAt)}
                    </span>
                  ) : null}
                  <span className="ml-auto flex items-center gap-2">
                    {record.attempt.live ? <Badge variant="success">live</Badge> : null}
                    {latest ? (
                      <Badge variant={latest.status === 'pass' ? 'success' : 'destructive'}>
                        {latest.status === 'pass' ? 'Verified' : `Verify ${latest.status}`}
                      </Badge>
                    ) : (
                      <Badge variant="outline">Not verified</Badge>
                    )}
                  </span>
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="border-t px-4 py-4">
                <AttemptRecordView
                  repositoryId={repositoryId}
                  record={record}
                  showWorkUnit={false}
                  defaultExpandedId={pickDefaultSession(record.timeline)?.id ?? null}
                />
              </CollapsibleContent>
            </div>
          </Collapsible>
        );
      })}
    </div>
  );
}
