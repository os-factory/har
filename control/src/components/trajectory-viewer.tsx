'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Clock, Download, MessageSquare, Search, Trash2, Wrench } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatAgentToolLabel } from '@/lib/agent-tool';
import { cn } from '@/lib/utils';
import {
  assembleTrajectory,
  countTrajectoryCalls,
  countTrajectoryTurns,
  formatDurationMs,
  mergeTrajectoryRecords,
  nodeDurationMs,
  nodeMatchesQuery,
  previewTrajectoryNode,
  safeTrajectoryBody,
  sequenceGap,
  sessionDurationMs,
  trajectoryOverviewPlacement,
  trajectoryRoleLabel,
  type SerializedTrajectoryPage,
  type SerializedTrajectoryRecord,
  type TrajectoryLane,
  type TrajectoryNode,
  type TrajectoryNodeKind,
  type TrajectoryStream,
} from '@/lib/trajectory';

type LiveStatus = 'live' | 'reconnecting' | 'offline';

const LANE_ORDER: Array<Exclude<TrajectoryLane, 'other'>> = ['input', 'model', 'tools'];
const LANE_LABEL: Record<Exclude<TrajectoryLane, 'other'>, string> = {
  input: 'Input',
  model: 'Model',
  tools: 'Tools',
};

function streamKey(stream: TrajectoryStream): string {
  return JSON.stringify([stream.sessionKey, stream.agentTool]);
}

function endpoint(
  repositoryId: string,
  agentId: number,
  stream: TrajectoryStream,
  suffix = '',
): string {
  const params = new URLSearchParams({
    sessionKey: stream.sessionKey,
    agentTool: stream.agentTool,
  });
  return `/api/repos/${encodeURIComponent(repositoryId)}/slots/${agentId}/trajectory${suffix}?${params}`;
}

function bodyText(value: unknown): string {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && trimmed.length > 1) {
      try {
        return JSON.stringify(JSON.parse(trimmed), null, 2);
      } catch {
        return value;
      }
    }
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value && typeof value === 'object' && 'stringValue' in value) {
    const stringValue = (value as { stringValue?: unknown }).stringValue;
    if (typeof stringValue === 'string') return bodyText(stringValue);
  }
  return JSON.stringify(value, null, 2);
}

const DISCLOSURE_LABEL: Record<string, string> = {
  full: 'Full content',
  metadata_only: 'Metadata only',
  truncated: 'Truncated',
  redacted: 'Redacted',
  masked: 'Masked',
  withheld: 'Withheld',
};

function disclosureLabel(disclosure: string): string {
  return DISCLOSURE_LABEL[disclosure] ?? disclosure;
}

function disclosureCopy(record: SerializedTrajectoryRecord): string {
  if (record.contentDisclosure === 'withheld') {
    const payload = record.payload && typeof record.payload === 'object'
      ? record.payload as { disclosure?: { withheld?: unknown } }
      : null;
    const reason = payload?.disclosure?.withheld;
    return typeof reason === 'string' && reason
      ? `Content withheld: ${reason}.`
      : 'Content withheld by the producer.';
  }
  if (record.contentDisclosure === 'metadata_only') return 'Metadata only; no content was recorded.';
  if (record.contentDisclosure === 'truncated') return 'Truncated content';
  if (record.contentDisclosure === 'redacted') return 'Redacted content';
  if (record.contentDisclosure === 'masked') return 'Masked content';
  return 'Recorded content';
}

function roleTone(kind: TrajectoryNodeKind): string {
  switch (kind) {
    case 'prompt':
      return 'text-[hsl(var(--trajectory-user))] bg-[hsl(var(--trajectory-user)/0.14)]';
    case 'response':
    case 'reasoning':
      return 'text-[hsl(var(--trajectory-assistant))] bg-[hsl(var(--trajectory-assistant)/0.14)]';
    case 'tool':
    case 'subagent':
      return 'text-[hsl(var(--trajectory-tool))] bg-[hsl(var(--trajectory-tool)/0.16)]';
    case 'error':
      return 'text-[hsl(var(--trajectory-error))] bg-[hsl(var(--trajectory-error)/0.14)]';
    default:
      return 'text-[hsl(var(--trajectory-system))] bg-[hsl(var(--trajectory-system)/0.14)]';
  }
}

function laneBarClass(lane: Exclude<TrajectoryLane, 'other'>): string {
  if (lane === 'input') return 'bg-[hsl(var(--trajectory-user))]';
  if (lane === 'model') return 'bg-[hsl(var(--trajectory-assistant))]';
  return 'bg-[hsl(var(--trajectory-tool))]';
}

function roleDotClass(kind: TrajectoryNodeKind): string {
  switch (kind) {
    case 'prompt':
      return 'bg-[hsl(var(--trajectory-user))]';
    case 'response':
    case 'reasoning':
      return 'bg-[hsl(var(--trajectory-assistant))]';
    case 'tool':
    case 'subagent':
      return 'bg-[hsl(var(--trajectory-tool))]';
    case 'error':
      return 'bg-[hsl(var(--trajectory-error))]';
    default:
      return 'bg-[hsl(var(--trajectory-system))]';
  }
}

function statusLabel(status: TrajectoryNode['status']): string | null {
  if (!status) return null;
  if (status === 'running') return 'Running';
  if (status === 'completed') return 'Completed';
  if (status === 'unmatched') return 'Unmatched';
  return 'Error';
}

function turnIndex(nodes: TrajectoryNode[], nodeId: string): number | null {
  let turn = 0;
  for (const node of nodes) {
    if (node.kind === 'prompt') turn += 1;
    if (node.id === nodeId) return node.kind === 'prompt' || turn > 0 ? Math.max(turn, 1) : null;
  }
  return null;
}

function payloadRecord(node: TrajectoryNode): SerializedTrajectoryRecord {
  return node.records[0];
}

function resultRecord(node: TrajectoryNode): SerializedTrajectoryRecord | null {
  return node.records.length > 1 ? node.records[node.records.length - 1] : null;
}

function RecordBody({ record }: { record: SerializedTrajectoryRecord }) {
  const body = safeTrajectoryBody(record);
  if (body == null) {
    return <p className="text-xs italic text-muted-foreground">{disclosureCopy(record)}</p>;
  }
  return (
    <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-background/80 p-2 font-mono text-[11px] leading-relaxed">
      {bodyText(body)}
    </pre>
  );
}

function TrajectoryOverview({
  nodes,
  selectedId,
  onSelect,
}: {
  nodes: TrajectoryNode[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const placements = useMemo(() => trajectoryOverviewPlacement(nodes), [nodes]);
  if (placements.length === 0) return null;

  return (
    <div className="space-y-1.5 rounded-md border bg-muted/30 px-3 py-2" aria-label="Trajectory overview">
      {LANE_ORDER.map((lane) => {
        const bars = placements.filter((item) => item.lane === lane);
        return (
          <div key={lane} className="grid grid-cols-[3.25rem_minmax(0,1fr)] items-center gap-2">
            <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {LANE_LABEL[lane]}
            </span>
            <div className="relative h-3.5 overflow-hidden rounded-sm bg-background/70">
              {bars.map((bar) => (
                <button
                  key={bar.id}
                  type="button"
                  title={nodes.find((node) => node.id === bar.id)?.title}
                  aria-label={`${LANE_LABEL[lane]} ${nodes.find((node) => node.id === bar.id)?.title ?? bar.id}`}
                  aria-pressed={selectedId === bar.id}
                  onClick={() => onSelect(bar.id)}
                  className={cn(
                    'absolute top-0.5 h-2.5 rounded-sm transition-opacity',
                    laneBarClass(lane),
                    selectedId === bar.id ? 'opacity-100 ring-1 ring-ring' : 'opacity-80 hover:opacity-100',
                  )}
                  style={{ left: `${bar.left}%`, width: `${bar.width}%` }}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TrajectoryLog({
  nodes,
  selectedId,
  onSelect,
}: {
  nodes: TrajectoryNode[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  let turn = 0;

  return (
    <ol className="relative space-y-0" aria-label="Agent trajectory timeline">
      <span aria-hidden className="absolute bottom-2 left-[11px] top-2 w-px bg-border" />
      {nodes.map((node) => {
        if (node.kind === 'prompt') turn += 1;
        const currentTurn = turn;
        const preview = previewTrajectoryNode(node);
        const duration = nodeDurationMs(node);
        const selected = selectedId === node.id;
        return (
          <li key={node.id} className="relative">
            <button
              type="button"
              aria-pressed={selected}
              onClick={() => onSelect(node.id)}
              className={cn(
                'flex w-full gap-3 rounded-md px-2 py-2 text-left transition-colors',
                selected ? 'bg-primary/10' : 'hover:bg-muted/60',
              )}
            >
              <span
                aria-hidden
                className={cn(
                  'mt-1.5 h-2 w-2 shrink-0 rounded-full ring-2 ring-background',
                  roleDotClass(node.kind),
                )}
              />
              <span className="min-w-0 flex-1 space-y-1">
                <span className="flex flex-wrap items-center gap-2">
                  {node.kind === 'prompt' ? (
                    <span className="rounded border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
                      Turn {currentTurn}
                    </span>
                  ) : null}
                  <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wider', roleTone(node.kind))}>
                    {trajectoryRoleLabel(node.kind)}
                  </span>
                  <span className="truncate text-sm font-medium">{node.title}</span>
                  {duration != null ? (
                    <span className="ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground">
                      {formatDurationMs(duration)}
                    </span>
                  ) : (
                    <time className="ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground" dateTime={node.startedAt}>
                      {new Date(node.startedAt).toLocaleTimeString()}
                    </time>
                  )}
                </span>
                {preview ? (
                  <span className="line-clamp-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
                    {preview}
                  </span>
                ) : node.note ? (
                  <span className="line-clamp-2 text-[11px] italic text-muted-foreground">{node.note}</span>
                ) : null}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function TrajectoryInspector({
  node,
  nodes,
}: {
  node: TrajectoryNode | null;
  nodes: TrajectoryNode[];
}) {
  if (!node) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        Select an event to inspect payload, result, and timing.
      </div>
    );
  }

  const payload = payloadRecord(node);
  const result = resultRecord(node);
  const duration = nodeDurationMs(node);
  const turn = turnIndex(nodes, node.id);
  const step = nodes.findIndex((item) => item.id === node.id) + 1;

  return (
    <div className="flex h-full min-h-0 flex-col" aria-label="Trajectory inspector">
      <div className="space-y-2 border-b px-3 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wider', roleTone(node.kind))}>
            {trajectoryRoleLabel(node.kind)}
          </span>
          <h3 className="text-sm font-semibold">{node.title}</h3>
        </div>
        <p className="text-[11px] text-muted-foreground">
          {turn ? `Turn ${turn}` : 'Session'}
          {step ? ` · Step ${step}` : ''}
          {statusLabel(node.status) ? ` · ${statusLabel(node.status)}` : ''}
        </p>
      </div>
      <Tabs defaultValue="summary" className="flex min-h-0 flex-1 flex-col">
        <TabsList className="mx-3 mt-3 h-8 w-auto justify-start self-start">
          <TabsTrigger value="summary" className="px-2 text-xs">Summary</TabsTrigger>
          <TabsTrigger value="payload" className="px-2 text-xs">Payload</TabsTrigger>
          <TabsTrigger value="result" className="px-2 text-xs">Result</TabsTrigger>
          <TabsTrigger value="timing" className="px-2 text-xs">Timing</TabsTrigger>
        </TabsList>
        <div className="min-h-0 flex-1 overflow-auto px-3 py-3">
          <TabsContent value="summary" className="mt-0 space-y-3">
            <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-2 gap-y-1.5 text-xs">
              <dt className="text-muted-foreground">Kind</dt>
              <dd className="font-medium">{node.kind}</dd>
              <dt className="text-muted-foreground">Status</dt>
              <dd>{statusLabel(node.status) ?? '—'}</dd>
              <dt className="text-muted-foreground">Disclosure</dt>
              <dd>{disclosureLabel(payload.contentDisclosure)}{result && result.contentDisclosure !== payload.contentDisclosure ? ` → ${disclosureLabel(result.contentDisclosure)}` : ''}</dd>
              {payload.toolCallId ? (
                <>
                  <dt className="text-muted-foreground">Call id</dt>
                  <dd className="truncate font-mono text-[11px]">{payload.toolCallId}</dd>
                </>
              ) : null}
            </dl>
            {node.note ? <p className="text-xs text-muted-foreground">{node.note}</p> : null}
            {node.records.map((record) => (
              record.contentDisclosure !== 'full' ? (
                <p key={record.id} className="text-xs italic text-muted-foreground">{disclosureCopy(record)}</p>
              ) : null
            ))}
          </TabsContent>
          <TabsContent value="payload" className="mt-0 space-y-2">
            <p className="text-[11px] text-muted-foreground">{payload.contentLabel || payload.eventType}</p>
            <RecordBody record={payload} />
          </TabsContent>
          <TabsContent value="result" className="mt-0 space-y-2">
            {result ? (
              <>
                <p className="text-[11px] text-muted-foreground">{result.contentLabel || result.eventType}</p>
                <RecordBody record={result} />
              </>
            ) : (
              <p className="text-xs italic text-muted-foreground">
                {node.kind === 'tool' || node.kind === 'subagent'
                  ? 'No result record yet.'
                  : 'This event has a single record; see Payload.'}
              </p>
            )}
          </TabsContent>
          <TabsContent value="timing" className="mt-0">
            <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-2 gap-y-1.5 text-xs">
              <dt className="text-muted-foreground">Started</dt>
              <dd>
                <time dateTime={node.startedAt}>{new Date(node.startedAt).toLocaleString()}</time>
              </dd>
              <dt className="text-muted-foreground">Ended</dt>
              <dd>
                {node.endedAt
                  ? <time dateTime={node.endedAt}>{new Date(node.endedAt).toLocaleString()}</time>
                  : '—'}
              </dd>
              <dt className="text-muted-foreground">Duration</dt>
              <dd>{duration != null ? formatDurationMs(duration) : '—'}</dd>
              <dt className="text-muted-foreground">Sequence</dt>
              <dd className="font-mono text-[11px]">
                {node.records[0].sequence}
                {node.records.length > 1 ? ` → ${node.records[node.records.length - 1].sequence}` : ''}
              </dd>
            </dl>
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}

export function TrajectoryViewer({
  repositoryId,
  agentId,
  streams,
  initialPage,
}: {
  repositoryId: string;
  agentId: number;
  streams: TrajectoryStream[];
  initialPage: SerializedTrajectoryPage;
}) {
  const initialStream = streams[0] ?? null;
  const [selectedKey, setSelectedKey] = useState(initialStream ? streamKey(initialStream) : '');
  const [loadedKey, setLoadedKey] = useState(selectedKey);
  const [records, setRecords] = useState(initialPage.records);
  const [before, setBefore] = useState(initialPage.nextBefore);
  const [hasMore, setHasMore] = useState(initialPage.hasMore);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [connectionSeed, setConnectionSeed] = useState(0);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState<LiveStatus>(
    typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'reconnecting',
  );
  const recordsRef = useRef(records);
  const cursorRef = useRef(initialPage.latest);
  const appendChain = useRef(Promise.resolve());
  const selected = streams.find((stream) => streamKey(stream) === selectedKey) ?? null;
  const nodes = useMemo(() => assembleTrajectory(records), [records]);
  const visibleNodes = useMemo(() => nodes.filter((node) => nodeMatchesQuery(node, query)), [nodes, query]);
  const selectedNode = visibleNodes.find((node) => node.id === selectedId)
    ?? visibleNodes.find((node) => node.kind === 'prompt')
    ?? visibleNodes[0]
    ?? null;
  const duration = sessionDurationMs(nodes);
  const turns = countTrajectoryTurns(nodes);
  const calls = countTrajectoryCalls(nodes);

  const replaceRecords = (next: SerializedTrajectoryRecord[]) => {
    recordsRef.current = next;
    setRecords(next);
  };

  useEffect(() => {
    const online = () => setStatus('reconnecting');
    const offline = () => setStatus('offline');
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    return () => {
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
    };
  }, []);

  useEffect(() => {
    if (!selected || loadedKey !== selectedKey) return;
    const url = new URL(endpoint(repositoryId, agentId, selected, '/stream'), window.location.origin);
    if (cursorRef.current) url.searchParams.set('after', cursorRef.current);
    const source = new EventSource(url);
    source.onopen = () => setStatus('live');
    source.onerror = () => setStatus(navigator.onLine ? 'reconnecting' : 'offline');
    source.addEventListener('trajectory', (event) => {
      const message = event as MessageEvent<string>;
      appendChain.current = appendChain.current.then(async () => {
        const incoming = JSON.parse(message.data) as SerializedTrajectoryRecord;
        if (sequenceGap(recordsRef.current, incoming) && cursorRef.current) {
          let after: string | null = cursorRef.current;
          do {
            const repairUrl = new URL(endpoint(repositoryId, agentId, selected), window.location.origin);
            repairUrl.searchParams.set('after', after);
            repairUrl.searchParams.set('limit', '999');
            const response = await fetch(repairUrl);
            if (!response.ok) throw new Error(`Gap repair failed (${response.status})`);
            const page = await response.json() as SerializedTrajectoryPage;
            replaceRecords(mergeTrajectoryRecords(recordsRef.current, page.records));
            cursorRef.current = page.latest ?? after;
            after = page.nextAfter ?? null;
          } while (after);
        }
        replaceRecords(mergeTrajectoryRecords(recordsRef.current, [incoming]));
        cursorRef.current = message.lastEventId || cursorRef.current;
      }).catch(() => setStatus(navigator.onLine ? 'reconnecting' : 'offline'));
    });
    return () => source.close();
  }, [agentId, connectionSeed, loadedKey, repositoryId, selected, selectedKey]);

  const chooseStream = async (key: string) => {
    const stream = streams.find((item) => streamKey(item) === key);
    if (!stream) return;
    setLoadedKey('');
    setSelectedKey(key);
    setSelectedId(null);
    setStatus(navigator.onLine ? 'reconnecting' : 'offline');
    replaceRecords([]);
    const response = await fetch(endpoint(repositoryId, agentId, stream));
    if (!response.ok) {
      setStatus('offline');
      return;
    }
    const page = await response.json() as SerializedTrajectoryPage;
    replaceRecords(page.records);
    setBefore(page.nextBefore);
    setHasMore(page.hasMore);
    cursorRef.current = page.latest;
    setLoadedKey(key);
    setConnectionSeed((value) => value + 1);
  };

  const logScrollRef = useRef<HTMLDivElement | null>(null);
  const olderSentinelRef = useRef<HTMLDivElement | null>(null);
  const loadingOlderRef = useRef(false);

  // Older records are prepended, so keep the viewport anchored on what the user was reading.
  const loadOlder = async () => {
    if (!selected || !before || loadingOlderRef.current) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    const scroller = logScrollRef.current;
    const heightBefore = scroller?.scrollHeight ?? 0;
    const topBefore = scroller?.scrollTop ?? 0;
    try {
      const url = new URL(endpoint(repositoryId, agentId, selected), window.location.origin);
      url.searchParams.set('before', before);
      const response = await fetch(url);
      if (!response.ok) return;
      const page = await response.json() as SerializedTrajectoryPage;
      replaceRecords(mergeTrajectoryRecords(page.records, recordsRef.current));
      setBefore(page.nextBefore);
      setHasMore(page.hasMore);
      requestAnimationFrame(() => {
        if (scroller) scroller.scrollTop = topBefore + (scroller.scrollHeight - heightBefore);
      });
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  };

  // Start at the newest record; older history is above.
  useEffect(() => {
    const scroller = logScrollRef.current;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [loadedKey]);

  // Infinite scroll: no pagination controls, older records load as the sentinel at the
  // top of the log scrolls into view.
  useEffect(() => {
    const sentinel = olderSentinelRef.current;
    const root = logScrollRef.current;
    if (!sentinel || !root || !hasMore || !before) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadOlder();
    }, { root, rootMargin: '120px 0px 0px 0px' });
    observer.observe(sentinel);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [before, hasMore, selectedKey, nodes.length]);

  if (streams.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No trajectory records yet. New OTEL-hook or harvested agent facts will appear here.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
        {streams.length > 1 ? (
          <Select value={selectedKey} onValueChange={(value) => void chooseStream(value)}>
            <SelectTrigger className="max-w-md" aria-label="Select trajectory session and agent">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {streams.map((stream) => (
                <SelectItem key={streamKey(stream)} value={streamKey(stream)}>
                  {formatAgentToolLabel(stream.agentTool)} · {stream.sessionKey}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <p className="truncate text-xs text-muted-foreground">
            {formatAgentToolLabel(streams[0].agentTool)} · {streams[0].sessionKey}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1" aria-label={`Duration ${duration != null ? formatDurationMs(duration) : 'unknown'}`}>
              <Clock className="h-3 w-3" />
              <span className="font-medium text-foreground">{duration != null ? formatDurationMs(duration) : '—'}</span>
              Duration
            </span>
            <span className="inline-flex items-center gap-1" aria-label={`${turns} turns`}>
              <MessageSquare className="h-3 w-3" />
              <span className="font-medium text-foreground">{turns}</span>
              Turns
            </span>
            <span className="inline-flex items-center gap-1" aria-label={`${calls} calls`}>
              <Wrench className="h-3 w-3" />
              <span className="font-medium text-foreground">{calls}</span>
              Calls
            </span>
          </div>
          {selected ? (
            <>
              <Button variant="outline" size="sm" asChild>
                <a href={endpoint(repositoryId, agentId, selected, '') + '&format=jsonl'} download>
                  <Download className="mr-1.5 h-3.5 w-3.5" />
                  Export JSONL
                </a>
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (!window.confirm('Delete this session trajectory from local Mission Control? Usage totals are kept.')) {
                    return;
                  }
                  void fetch(endpoint(repositoryId, agentId, selected), { method: 'DELETE' }).then((response) => {
                    if (!response.ok) return;
                    replaceRecords([]);
                    setBefore(null);
                    setHasMore(false);
                    setSelectedId(null);
                    cursorRef.current = null;
                  });
                }}
              >
                <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                Delete session
              </Button>
            </>
          ) : null}
          <Badge variant="outline" aria-label={`Trajectory connection ${status}`}>
            <span className={`mr-1.5 h-2 w-2 rounded-full ${status === 'live' ? 'bg-emerald-500' : status === 'offline' ? 'bg-destructive' : 'bg-amber-500'}`} />
            {status}
          </Badge>
        </div>
      </div>

      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search the trajectory…"
          aria-label="Search trajectory"
          className="h-8 pl-8 text-sm"
        />
      </div>

      {nodes.length === 0 ? (
        <p className="text-sm text-muted-foreground">No records in this trajectory stream.</p>
      ) : visibleNodes.length === 0 ? (
        <p className="text-sm text-muted-foreground">No events match this search.</p>
      ) : (
        <div className="space-y-3">
          <TrajectoryOverview
            nodes={visibleNodes}
            selectedId={selectedNode?.id ?? null}
            onSelect={setSelectedId}
          />
          <div className="overflow-hidden rounded-lg border">
            <div className="grid h-[32rem] max-h-[70vh] lg:grid-cols-[minmax(0,1fr)_minmax(17rem,22rem)]">
              <div
                ref={logScrollRef}
                className="min-h-0 overflow-auto border-b p-2 lg:border-b-0 lg:border-r"
                data-testid="trajectory-log-scroll"
              >
                {hasMore && before ? (
                  <div ref={olderSentinelRef} className="py-1 text-center text-[11px] text-muted-foreground" aria-live="polite">
                    {loadingOlder ? 'Loading older records…' : 'Scroll up for older records'}
                  </div>
                ) : null}
                <TrajectoryLog
                  nodes={visibleNodes}
                  selectedId={selectedNode?.id ?? null}
                  onSelect={setSelectedId}
                />
              </div>
              <div className="min-h-0 overflow-hidden bg-muted/20">
                <TrajectoryInspector node={selectedNode} nodes={visibleNodes} />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
