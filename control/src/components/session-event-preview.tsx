'use client';

import { Badge } from '@/components/ui/badge';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { formatAgentToolLabel } from '@/lib/agent-tool';
import {
  displayEventType,
  displayPromptText,
  summarizeEventAttributes,
} from '@/lib/session-event-detail';
import type { SessionEventRow } from '@/components/columns/session-event-columns';

export function SessionEventPreview({
  event,
  open,
  onOpenChange,
}: {
  event: SessionEventRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const prompt = displayPromptText(event?.promptText);
  const response = displayPromptText(event?.responseText);
  const lines = event ? summarizeEventAttributes(event.attributes) : [];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-4 overflow-y-auto sm:max-w-xl">
        {event && (
          <>
            <SheetHeader>
              <SheetTitle className="pr-8 font-mono text-base">
                {displayEventType(event.eventName, event.rawTruncated)}
              </SheetTitle>
              <SheetDescription className="space-y-1">
                <span className="block" suppressHydrationWarning>
                  {event.timestamp.toLocaleString()}
                </span>
                <span className="block break-all font-mono text-xs">{event.sessionKey}</span>
              </SheetDescription>
            </SheetHeader>

            <div className="flex flex-wrap gap-2">
              <Badge variant="outline">{formatAgentToolLabel(event.agentTool)}</Badge>
              <Badge variant="secondary">{event.source}</Badge>
              <Badge variant="outline" title={event.eventName}>
                {event.eventName}
              </Badge>
            </div>

            {prompt && (
              <section className="space-y-1">
                <h3 className="text-sm font-medium">Prompt</h3>
                <pre className="whitespace-pre-wrap rounded-md border bg-muted/40 p-3 text-xs">
                  {prompt}
                </pre>
              </section>
            )}

            {response && (
              <section className="space-y-1">
                <h3 className="text-sm font-medium">Response</h3>
                <pre className="whitespace-pre-wrap rounded-md border bg-muted/40 p-3 text-xs">
                  {response}
                </pre>
              </section>
            )}

            {lines.length > 0 && (
              <section className="space-y-1">
                <h3 className="text-sm font-medium">Highlights</h3>
                <ul className="space-y-1 text-xs text-muted-foreground">
                  {lines.map((line) => (
                    <li key={line} className="break-all font-mono">
                      {line}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {event.rawTruncated && (
              <section className="space-y-1">
                <h3 className="text-sm font-medium">Log body</h3>
                <pre className="whitespace-pre-wrap rounded-md border bg-muted/40 p-3 text-xs">
                  {event.rawTruncated}
                </pre>
              </section>
            )}

            {event.attributes != null && (
              <section className="space-y-1">
                <h3 className="text-sm font-medium">Attributes</h3>
                <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-3 text-xs">
                  {JSON.stringify(event.attributes, null, 2)}
                </pre>
              </section>
            )}
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
