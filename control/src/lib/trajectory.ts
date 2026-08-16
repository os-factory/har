export type TrajectoryDisclosure =
  | 'full'
  | 'redacted'
  | 'masked'
  | 'truncated'
  | 'withheld'
  | 'metadata_only';

export interface SerializedTrajectoryRecord {
  id: string;
  repositoryId: string;
  version: number;
  source: string;
  sourceEventId: string;
  contentKey: string;
  sessionKey: string;
  agentId: number;
  agentTool: string;
  eventType: string;
  sequence: number;
  eventTimestamp: string;
  payload: unknown;
  contentKind: string;
  contentDisclosure: TrajectoryDisclosure;
  contentLabel: string | null;
  traceId: string | null;
  spanId: string | null;
  parentSpanId: string | null;
  generationId: string | null;
  toolCallId: string | null;
  correlationId: string | null;
  workUnitId: string | null;
  attemptId: string | null;
  createdAt: string;
}

export interface TrajectoryStream {
  sessionKey: string;
  agentTool: string;
  latestTimestamp: string;
}

export interface SerializedTrajectoryPage {
  records: SerializedTrajectoryRecord[];
  hasMore: boolean;
  nextBefore: string | null;
  latest: string | null;
  nextAfter?: string | null;
}

export type TrajectoryNodeKind =
  | 'prompt'
  | 'response'
  | 'reasoning'
  | 'tool'
  | 'subagent'
  | 'error'
  | 'metadata'
  | 'event';

export interface TrajectoryNode {
  id: string;
  kind: TrajectoryNodeKind;
  title: string;
  status?: 'running' | 'completed' | 'error' | 'unmatched';
  startedAt: string;
  endedAt?: string;
  records: SerializedTrajectoryRecord[];
  note?: string;
}

const TOOL_CALL_ID_KEYS = [
  'otelhook.tool.call.id',
  'otelhook.tool_call.id',
  'gen_ai.tool.call.id',
  'tool.call.id',
  'tool_call_id',
  'toolCallId',
];
const SUBAGENT_ID_KEYS = [
  'otelhook.subagent.id',
  'subagent.id',
  'subagent_id',
  'subagentId',
];

function asObject(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function trajectoryAttributes(record: SerializedTrajectoryRecord): Record<string, unknown> {
  return asObject(asObject(record.payload)?.attributes) ?? {};
}

function attributeString(record: SerializedTrajectoryRecord, keys: string[]): string | null {
  const attributes = trajectoryAttributes(record);
  for (const key of keys) {
    const value = attributes[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return null;
}

export function compareSerializedTrajectory(
  left: SerializedTrajectoryRecord,
  right: SerializedTrajectoryRecord,
): number {
  return (
    left.sequence - right.sequence ||
    left.eventTimestamp.localeCompare(right.eventTimestamp) ||
    left.source.localeCompare(right.source) ||
    left.sourceEventId.localeCompare(right.sourceEventId) ||
    left.contentKey.localeCompare(right.contentKey) ||
    left.id.localeCompare(right.id)
  );
}

export function mergeTrajectoryRecords(
  ...groups: SerializedTrajectoryRecord[][]
): SerializedTrajectoryRecord[] {
  const byId = new Map<string, SerializedTrajectoryRecord>();
  for (const record of groups.flat()) byId.set(record.id, record);
  return [...byId.values()].sort(compareSerializedTrajectory);
}

function pairingKey(
  record: SerializedTrajectoryRecord,
  kind: 'tool' | 'subagent',
): { key: string; confidence: 'explicit' | 'fallback' } {
  if (kind === 'tool' && record.toolCallId) {
    return { key: `explicit:${record.toolCallId}`, confidence: 'explicit' };
  }
  const explicit = attributeString(record, kind === 'tool' ? TOOL_CALL_ID_KEYS : SUBAGENT_ID_KEYS);
  if (explicit) return { key: `explicit:${explicit}`, confidence: 'explicit' };
  if (record.correlationId) return { key: `correlation:${record.correlationId}`, confidence: 'fallback' };
  return { key: `event:${record.sourceEventId}`, confidence: 'fallback' };
}

function sessionBookendTitle(record: SerializedTrajectoryRecord): string | null {
  const event = record.eventType.toLowerCase().replaceAll('_', '.');
  if (event === 'session.start' || event.endsWith('.session.start')) return 'Session started';
  if (event === 'session.end' || event.endsWith('.session.end')) return 'Session ended';
  return null;
}

function contentTitle(record: SerializedTrajectoryRecord, fallback: string): string {
  return record.contentLabel?.trim() ||
    sessionBookendTitle(record) ||
    attributeString(record, [
      'otelhook.tool.name',
      'gen_ai.tool.name',
      'tool.name',
      'otelhook.subagent.name',
      'subagent.name',
    ]) ||
    fallback;
}

function eventOutcome(record: SerializedTrajectoryRecord): string | null {
  return attributeString(record, ['otelhook.outcome', 'gen_ai.tool.outcome', 'outcome']);
}

function simpleKind(record: SerializedTrajectoryRecord): TrajectoryNodeKind {
  const content = record.contentKind.toLowerCase();
  const event = record.eventType.toLowerCase();
  if (content === 'prompt' || content === 'user' || event.includes('prompt')) return 'prompt';
  if (content === 'response' || content === 'assistant' || event.includes('response')) return 'response';
  if (content.includes('reasoning')) return 'reasoning';
  if (event.includes('error') || event.includes('fail') || content.includes('error')) return 'error';
  if (
    event.includes('compaction') ||
    event.includes('session') ||
    event.includes('generation') ||
    content.includes('metadata')
  ) return 'metadata';
  return 'event';
}

function nodeForRecord(record: SerializedTrajectoryRecord): TrajectoryNode {
  const kind = simpleKind(record);
  const titles: Record<TrajectoryNodeKind, string> = {
    prompt: 'User prompt',
    response: 'Assistant response',
    reasoning: 'Reasoning',
    tool: 'Tool call',
    subagent: 'Subagent',
    error: 'Error',
    metadata: record.eventType,
    event: record.eventType,
  };
  return {
    id: record.id,
    kind,
    title: contentTitle(record, titles[kind]),
    status: kind === 'error' ? 'error' : undefined,
    startedAt: record.eventTimestamp,
    records: [record],
  };
}

function isBoundary(record: SerializedTrajectoryRecord, kind: 'tool' | 'subagent', side: 'start' | 'end') {
  const event = record.eventType.toLowerCase().replaceAll('_', '.');
  return event.includes(kind) && (
    event.endsWith(`.${side}`) ||
    event.includes(`.${side}.`) ||
    event.endsWith(`${kind}${side}`)
  );
}

export function isSpanMirrorRecord(record: SerializedTrajectoryRecord): boolean {
  return record.contentKind.toLowerCase() === 'span' ||
    record.eventType.toLowerCase().startsWith('span.');
}

/** Generation start/end with no message body — noise next to paired tools. Session bookends stay. */
export function isEmptyLifecycleBookend(record: SerializedTrajectoryRecord): boolean {
  const event = record.eventType.toLowerCase().replaceAll('_', '.');
  if (event.includes('tool') || event.includes('subagent') || event.includes('session')) {
    return false;
  }
  if (!/(^|\.)(start|end)$/.test(event)) return false;
  const kind = record.contentKind.toLowerCase();
  return !['prompt', 'response', 'reasoning', 'user', 'assistant'].includes(kind);
}

function unwrapTrajectoryValue(value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as { stringValue?: unknown };
    if (typeof record.stringValue === 'string') return record.stringValue;
  }
  return value;
}

export type TrajectoryLane = 'input' | 'model' | 'tools' | 'other';

export function trajectoryLane(kind: TrajectoryNodeKind): TrajectoryLane {
  if (kind === 'prompt') return 'input';
  if (kind === 'response' || kind === 'reasoning') return 'model';
  if (kind === 'tool' || kind === 'subagent') return 'tools';
  return 'other';
}

export function trajectoryRoleLabel(kind: TrajectoryNodeKind): string {
  switch (kind) {
    case 'prompt':
      return 'USER';
    case 'response':
      return 'ASSISTANT';
    case 'reasoning':
      return 'REASON';
    case 'tool':
      return 'TOOL';
    case 'subagent':
      return 'AGENT';
    case 'error':
      return 'ERROR';
    default:
      return 'SYSTEM';
  }
}

export function nodeDurationMs(node: TrajectoryNode): number | null {
  if (!node.endedAt) return null;
  const ms = new Date(node.endedAt).getTime() - new Date(node.startedAt).getTime();
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

export function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

export function sessionDurationMs(nodes: TrajectoryNode[]): number | null {
  if (nodes.length === 0) return null;
  const starts = nodes.map((node) => new Date(node.startedAt).getTime());
  const ends = nodes.map((node) => new Date(node.endedAt ?? node.startedAt).getTime());
  const ms = Math.max(...ends) - Math.min(...starts);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

export function countTrajectoryTurns(nodes: TrajectoryNode[]): number {
  return nodes.filter((node) => node.kind === 'prompt').length;
}

export function countTrajectoryCalls(nodes: TrajectoryNode[]): number {
  return nodes.filter((node) => node.kind === 'tool' || node.kind === 'subagent').length;
}

export function previewTrajectoryNode(node: TrajectoryNode): string {
  for (const record of node.records) {
    const body = safeTrajectoryBody(record);
    if (body == null) continue;
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    const compact = text.replace(/\s+/g, ' ').trim();
    if (compact) return compact.length > 160 ? `${compact.slice(0, 157)}…` : compact;
  }
  return node.note ?? '';
}

export function nodeMatchesQuery(node: TrajectoryNode, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [
    node.title,
    node.kind,
    trajectoryRoleLabel(node.kind),
    node.note ?? '',
    previewTrajectoryNode(node),
    ...node.records.flatMap((record) => [record.eventType, record.contentLabel ?? '']),
  ].join(' ').toLowerCase();
  return haystack.includes(needle);
}

export interface TrajectoryLanePlacement {
  id: string;
  lane: Exclude<TrajectoryLane, 'other'>;
  left: number;
  width: number;
}

export function trajectoryOverviewPlacement(nodes: TrajectoryNode[]): TrajectoryLanePlacement[] {
  const visible = nodes.filter((node) => trajectoryLane(node.kind) !== 'other');
  if (visible.length === 0) return [];

  const times = visible.flatMap((node) => [
    new Date(node.startedAt).getTime(),
    new Date(node.endedAt ?? node.startedAt).getTime(),
  ]);
  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);
  const useTime = Number.isFinite(minTime) && Number.isFinite(maxTime) && maxTime - minTime >= 400;

  if (useTime) {
    const span = Math.max(maxTime - minTime, 1);
    return visible.map((node) => {
      const start = new Date(node.startedAt).getTime();
      const end = new Date(node.endedAt ?? node.startedAt).getTime();
      return {
        id: node.id,
        lane: trajectoryLane(node.kind) as Exclude<TrajectoryLane, 'other'>,
        left: ((start - minTime) / span) * 100,
        width: Math.max(((Math.max(end, start) - start) / span) * 100, 1.6),
      };
    });
  }

  const sequences = visible.flatMap((node) => node.records.map((record) => record.sequence));
  const minSeq = Math.min(...sequences);
  const maxSeq = Math.max(...sequences);
  const span = Math.max(maxSeq - minSeq, 1);
  return visible.map((node) => {
    const start = node.records[0].sequence;
    const end = node.records[node.records.length - 1].sequence;
    return {
      id: node.id,
      lane: trajectoryLane(node.kind) as Exclude<TrajectoryLane, 'other'>,
      left: ((start - minSeq) / span) * 100,
      width: Math.max(((Math.max(end, start) - start + 1) / span) * 100, 2.4),
    };
  });
}

export function assembleTrajectory(records: SerializedTrajectoryRecord[]): TrajectoryNode[] {
  const ordered = mergeTrajectoryRecords(records).filter((record) =>
    !isSpanMirrorRecord(record) && !isEmptyLifecycleBookend(record),
  );
  const nodes: TrajectoryNode[] = [];
  const open = new Map<string, TrajectoryNode[]>();

  for (const record of ordered) {
    const boundaryKind = isBoundary(record, 'tool', 'start') || isBoundary(record, 'tool', 'end')
      ? 'tool'
      : isBoundary(record, 'subagent', 'start') || isBoundary(record, 'subagent', 'end')
        ? 'subagent'
        : null;
    if (!boundaryKind) {
      nodes.push(nodeForRecord(record));
      continue;
    }

    const start = isBoundary(record, boundaryKind, 'start');
    const { key, confidence } = pairingKey(record, boundaryKind);
    const mapKey = `${boundaryKind}:${key}`;
    if (start) {
      const node: TrajectoryNode = {
        id: record.id,
        kind: boundaryKind,
        title: contentTitle(record, boundaryKind === 'tool' ? 'Tool call' : 'Subagent'),
        status: 'running',
        startedAt: record.eventTimestamp,
        records: [record],
        note: confidence === 'fallback'
          ? 'Pairing uses correlation or event identity because no explicit call id was recorded.'
          : undefined,
      };
      nodes.push(node);
      const queue = open.get(mapKey) ?? [];
      queue.push(node);
      open.set(mapKey, queue);
      continue;
    }

    const matched = open.get(mapKey)?.shift();
    if (matched) {
      matched.records.push(record);
      matched.endedAt = record.eventTimestamp;
      const outcome = eventOutcome(record)?.toLowerCase();
      matched.status =
        record.eventType.toLowerCase().includes('error') ||
        outcome === 'error' ||
        outcome === 'timeout' ||
        outcome === 'denied'
          ? 'error'
          : 'completed';
    } else {
      nodes.push({
        id: record.id,
        kind: boundaryKind,
        title: contentTitle(record, boundaryKind === 'tool' ? 'Tool result' : 'Subagent result'),
        status: 'unmatched',
        startedAt: record.eventTimestamp,
        endedAt: record.eventTimestamp,
        records: [record],
        note: 'No matching start record was available; this result is shown independently.',
      });
    }
  }

  return nodes.sort((left, right) => {
    const first = compareSerializedTrajectory(left.records[0], right.records[0]);
    return first || left.id.localeCompare(right.id);
  });
}

export function safeTrajectoryBody(record: SerializedTrajectoryRecord): unknown | null {
  if (record.contentDisclosure === 'withheld' || record.contentDisclosure === 'metadata_only') {
    return null;
  }
  const payload = asObject(record.payload);
  if (!payload) return null;
  if (record.contentKind === 'prompt' && payload.promptText != null) {
    return unwrapTrajectoryValue(payload.promptText);
  }
  if (record.contentKind === 'response' && payload.responseText != null) {
    return unwrapTrajectoryValue(payload.responseText);
  }
  return unwrapTrajectoryValue(payload.body ?? payload.raw ?? null);
}

export function sequenceGap(
  records: SerializedTrajectoryRecord[],
  incoming: SerializedTrajectoryRecord,
): boolean {
  const latestSequence = records.reduce((maximum, record) => Math.max(maximum, record.sequence), -1);
  return latestSequence >= 0 && incoming.sequence > latestSequence + 1;
}
