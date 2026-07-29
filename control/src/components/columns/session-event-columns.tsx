'use client';

import { type ColumnDef } from '@tanstack/react-table';
import { Badge } from '@/components/ui/badge';
import { formatAgentToolLabel } from '@/lib/agent-tool';
import {
  displayEventType,
  eventDetailSummary,
  eventModel,
  eventToolName,
} from '@/lib/session-event-detail';

export interface SessionEventRow {
  id: string;
  eventName: string;
  sessionKey: string;
  agentTool: string;
  promptText: string | null;
  responseText: string | null;
  attributes: unknown;
  rawTruncated: string | null;
  source: string;
  timestamp: Date;
}

function trunc(text: string | null | undefined, max = 72): string {
  if (!text) return '—';
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

function eventTone(
  eventName: string,
  rawTruncated?: string | null,
): 'destructive' | 'success' | 'warning' | 'outline' | 'secondary' {
  const name = displayEventType(eventName, rawTruncated);
  if (/Failure|Error/i.test(name)) return 'destructive';
  if (name === 'UserPromptSubmit' || name.startsWith('Conversation:')) return 'success';
  if (name === 'Stop' || name === 'generation') return 'warning';
  if (eventName === 'log') return 'secondary';
  return 'outline';
}

export const sessionEventColumns: ColumnDef<SessionEventRow>[] = [
  {
    accessorKey: 'timestamp',
    header: 'Time',
    cell: ({ row }) => (
      <span className="whitespace-nowrap text-muted-foreground" suppressHydrationWarning>
        {row.original.timestamp.toLocaleString()}
      </span>
    ),
  },
  {
    id: 'type',
    accessorFn: (row) => displayEventType(row.eventName, row.rawTruncated),
    header: 'Type',
    cell: ({ row }) => {
      const label = displayEventType(row.original.eventName, row.original.rawTruncated);
      return (
        <Badge
          variant={eventTone(row.original.eventName, row.original.rawTruncated)}
          title={row.original.eventName}
        >
          {label}
        </Badge>
      );
    },
  },
  {
    accessorKey: 'agentTool',
    header: 'Agent',
    cell: ({ row }) => (
      <Badge variant="outline">{formatAgentToolLabel(row.original.agentTool)}</Badge>
    ),
  },
  {
    id: 'tool',
    accessorFn: (row) => eventToolName(row.attributes) ?? '',
    header: 'Tool',
    cell: ({ row }) => {
      const tool = eventToolName(row.original.attributes);
      return tool ? (
        <span className="font-mono text-xs">{tool}</span>
      ) : (
        <span className="text-muted-foreground">—</span>
      );
    },
  },
  {
    id: 'model',
    accessorFn: (row) => eventModel(row.attributes) ?? '',
    header: 'Model',
    cell: ({ row }) => {
      const model = eventModel(row.original.attributes);
      return model ? (
        <span className="max-w-28 truncate font-mono text-xs text-muted-foreground" title={model}>
          {model.replace(/^cursor-/, '')}
        </span>
      ) : (
        <span className="text-muted-foreground">—</span>
      );
    },
  },
  {
    id: 'detail',
    accessorFn: (row) =>
      eventDetailSummary(
        row.attributes,
        row.promptText,
        row.responseText,
        row.rawTruncated,
      ) ?? '',
    header: 'Detail',
    cell: ({ row }) => {
      const detail = eventDetailSummary(
        row.original.attributes,
        row.original.promptText,
        row.original.responseText,
        row.original.rawTruncated,
      );
      return (
        <span className="block max-w-md truncate font-mono text-xs" title={detail ?? undefined}>
          {trunc(detail, 96)}
        </span>
      );
    },
  },
];
