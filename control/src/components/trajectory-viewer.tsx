'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatAgentToolLabel } from '@/lib/agent-tool';
import {
  assembleTrajectory,
  mergeTrajectoryRecords,
  safeTrajectoryBody,
  sequenceGap,
  type SerializedTrajectoryPage,
  type SerializedTrajectoryRecord,
  type TrajectoryNode,
  type TrajectoryStream,
} from '@/lib/trajectory';

type LiveStatus = 'live' | 'reconnecting' | 'offline';

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
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value && typeof value === 'object' && 'stringValue' in value) {
    const stringValue = (value as { stringValue?: unknown }).stringValue;
    if (typeof stringValue === 'string') return stringValue;
  }
  return JSON.stringify(value, null, 2);
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

function statusVariant(status: TrajectoryNode['status']) {
  return status === 'error' ? 'destructive' as const : status === 'completed' ? 'secondary' as const : 'outline' as const;
}

function TrajectoryBlock({ node }: { node: TrajectoryNode }) {
  const expandable = node.kind === 'tool' || node.kind === 'subagent';
  if (expandable) {
    return (
      <Card className="border-l-4 border-l-muted-foreground/30">
        <Collapsible>
          <CardHeader className="space-y-1 p-0">
            <CollapsibleTrigger className="group flex w-full flex-wrap items-center gap-2 p-3 text-left">
              <ChevronRight className="h-3.5 w-3.5 transition-transform group-data-[state=open]:rotate-90" />
              <span className="text-sm font-semibold">{node.title}</span>
              <Badge variant="outline" className="text-[10px]">{node.kind}</Badge>
              {node.status ? (
                <Badge variant={statusVariant(node.status)} className="text-[10px]">{node.status}</Badge>
              ) : null}
              <time className="ml-auto text-[10px] text-muted-foreground" dateTime={node.startedAt}>
                {new Date(node.startedAt).toLocaleString()}
              </time>
            </CollapsibleTrigger>
            {node.note ? <p className="px-3 pb-2 text-xs text-muted-foreground">{node.note}</p> : null}
          </CardHeader>
          <CollapsibleContent>
            <CardContent className="space-y-2 p-3 pt-0">
              {node.records.map((record) => {
                const body = safeTrajectoryBody(record);
                return (
                  <div key={record.id} className="rounded-md border bg-muted/20 p-2">
                    <div className="mb-1 flex flex-wrap items-center gap-2 text-xs">
                      <span className="font-medium">{record.contentLabel || record.eventType}</span>
                      <Badge variant="outline" className="text-[10px]">{record.contentDisclosure}</Badge>
                    </div>
                    {body == null ? (
                      <p className="text-xs italic text-muted-foreground">{disclosureCopy(record)}</p>
                    ) : (
                      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs">{bodyText(body)}</pre>
                    )}
                  </div>
                );
              })}
            </CardContent>
          </CollapsibleContent>
        </Collapsible>
      </Card>
    );
  }

  const content = (
    <Card className="border-l-4 border-l-muted-foreground/30">
      <CardHeader className="space-y-1 p-3 pb-2">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-sm">{node.title}</CardTitle>
          <Badge variant="outline" className="text-[10px]">{node.kind}</Badge>
          {node.status ? (
            <Badge variant={statusVariant(node.status)} className="text-[10px]">{node.status}</Badge>
          ) : null}
          <time className="ml-auto text-[10px] text-muted-foreground" dateTime={node.startedAt}>
            {new Date(node.startedAt).toLocaleString()}
          </time>
        </div>
        {node.note ? <p className="text-xs text-muted-foreground">{node.note}</p> : null}
      </CardHeader>
      <CardContent className="space-y-2 p-3 pt-0">
        {node.records.map((record) => {
          const body = safeTrajectoryBody(record);
          return (
            <div key={record.id}>
              {body == null ? (
                <p className="text-xs italic text-muted-foreground">{disclosureCopy(record)}</p>
              ) : (
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-2 text-xs">
                  {bodyText(body)}
                </pre>
              )}
              {record.contentDisclosure !== 'full' ? (
                <Badge variant="outline" className="mt-1 text-[10px]">{record.contentDisclosure}</Badge>
              ) : null}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
  return content;
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
  const [status, setStatus] = useState<LiveStatus>(
    typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'reconnecting',
  );
  const recordsRef = useRef(records);
  const cursorRef = useRef(initialPage.latest);
  const appendChain = useRef(Promise.resolve());
  const selected = streams.find((stream) => streamKey(stream) === selectedKey) ?? null;
  const nodes = useMemo(() => assembleTrajectory(records), [records]);

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

  const loadOlder = async () => {
    if (!selected || !before) return;
    setLoadingOlder(true);
    try {
      const url = new URL(endpoint(repositoryId, agentId, selected), window.location.origin);
      url.searchParams.set('before', before);
      const response = await fetch(url);
      if (!response.ok) return;
      const page = await response.json() as SerializedTrajectoryPage;
      replaceRecords(mergeTrajectoryRecords(page.records, recordsRef.current));
      setBefore(page.nextBefore);
      setHasMore(page.hasMore);
    } finally {
      setLoadingOlder(false);
    }
  };

  if (streams.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No trajectory records yet. New OTEL-hook or harvested agent facts will appear here.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
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
          {selected ? (
            <>
              <Button variant="outline" size="sm" asChild>
                <a href={endpoint(repositoryId, agentId, selected, '') + '&format=jsonl'} download>
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
                    cursorRef.current = null;
                  });
                }}
              >
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
      {hasMore && before ? (
        <Button variant="outline" size="sm" disabled={loadingOlder} onClick={() => void loadOlder()}>
          {loadingOlder ? 'Loading…' : 'Load older'}
        </Button>
      ) : null}
      {nodes.length === 0 ? (
        <p className="text-sm text-muted-foreground">No records in this trajectory stream.</p>
      ) : (
        <div className="space-y-2" aria-label="Agent trajectory timeline">
          {nodes.map((node) => <TrajectoryBlock key={node.id} node={node} />)}
        </div>
      )}
    </div>
  );
}
