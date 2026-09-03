'use client';

import { useMemo } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { HistoryGraphEdge, HistoryGraphNode } from '@har/schemas';
import { cn } from '@/lib/utils';

const NODE_WIDTH = 220;
const NODE_HEIGHT = 84;
const COL_GAP = 64;
const ROW_GAP = 48;
const LANE_LABEL_WIDTH = 240;

/** Git-style 7-character abbreviation. */
export function shortHash(value: string | undefined | null): string {
  if (!value) return '—';
  return value.length > 7 ? value.slice(0, 7) : value;
}

type HistoryNodeData = HistoryGraphNode & { selected?: boolean };

function HistoryNode({ data }: { data: HistoryNodeData }) {
  const verified = data.full && data.status === 'pass';
  const failed = data.status === 'fail';
  return (
    <div
      className={cn(
        'w-[220px] rounded-xl border bg-card px-3 py-2 shadow-sm transition-shadow hover:shadow-md',
        data.pending && 'border-dashed',
        verified && 'border-emerald-500/60',
        failed && 'border-destructive/60',
        data.selected && 'ring-2 ring-primary',
      )}
      data-testid="session-history-node"
      data-node-kind={data.kind}
    >
      <Handle type="target" position={Position.Left} className="!size-2 !border-0 !bg-transparent" />
      <Handle type="source" position={Position.Right} className="!size-2 !border-0 !bg-transparent" />
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {data.pending ? 'Snapshot' : 'Commit'}
          {data.agentId != null ? ` · slot ${data.agentId}` : ''}
        </span>
        {verified ? (
          <span className="text-[10px] font-medium text-emerald-700 dark:text-emerald-400">Verified</span>
        ) : failed ? (
          <span className="text-[10px] font-medium text-destructive">Failed</span>
        ) : null}
      </div>
      <p className="mt-0.5 font-mono text-sm">{shortHash(data.commitSha ?? data.treeHash)}</p>
      <p className="truncate text-xs text-muted-foreground" title={data.message ?? data.branch ?? undefined}>
        {data.message?.split('\n')[0] ?? data.branch ?? 'content snapshot'}
      </p>
    </div>
  );
}

function LaneNode({ data }: { data: { label: string } }) {
  return (
    <div
      className="flex items-center justify-end pr-4 font-mono text-xs text-muted-foreground"
      style={{ width: LANE_LABEL_WIDTH, height: NODE_HEIGHT }}
      title={data.label}
    >
      <span className="truncate">{data.label}</span>
    </div>
  );
}

const nodeTypes: NodeTypes = {
  history: HistoryNode as unknown as NodeTypes[string],
  lane: LaneNode as unknown as NodeTypes[string],
};

function laneOf(node: HistoryGraphNode): string {
  return node.branch ?? (node.pending ? '(no branch)' : '(base)');
}

/**
 * Lanes are branches (rows); columns follow time, compacted so every node sits one
 * column after both its predecessors and the previous node of its lane. Nodes without
 * a timestamp — the base commits a session was launched from — take the time of their
 * first child so the based-on edge reads left to right.
 */
function layout(nodes: HistoryGraphNode[], edges: HistoryGraphEdge[]) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const timeOf = new Map<string, number>();
  const own = (node: HistoryGraphNode) => (node.createdAt ? Date.parse(node.createdAt) : Number.NaN);

  for (const node of nodes) {
    const t = own(node);
    if (!Number.isNaN(t)) timeOf.set(node.id, t);
  }
  for (const node of nodes) {
    if (timeOf.has(node.id)) continue;
    const childTimes = edges
      .filter((edge) => edge.source === node.id && byId.has(edge.target))
      .map((edge) => timeOf.get(edge.target))
      .filter((t): t is number => t != null);
    timeOf.set(node.id, childTimes.length ? Math.min(...childTimes) - 1 : 0);
  }

  const ordered = [...nodes].sort((a, b) => (timeOf.get(a.id)! - timeOf.get(b.id)!) || a.id.localeCompare(b.id));
  const lanes: string[] = [];
  for (const node of ordered) {
    const lane = laneOf(node);
    if (!lanes.includes(lane)) lanes.push(lane);
  }

  const incoming = new Map<string, string[]>();
  for (const edge of edges) {
    if (!byId.has(edge.source) || !byId.has(edge.target)) continue;
    incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge.source]);
  }
  const column = new Map<string, number>();
  const lastInLane = new Map<string, number>();
  const positions = new Map<string, { x: number; y: number }>();
  for (const node of ordered) {
    const lane = laneOf(node);
    const afterLane = lastInLane.has(lane) ? lastInLane.get(lane)! + 1 : 0;
    const afterSources = (incoming.get(node.id) ?? []).reduce((max, id) => Math.max(max, (column.get(id) ?? -1) + 1), 0);
    const col = Math.max(afterLane, afterSources);
    column.set(node.id, col);
    lastInLane.set(lane, col);
    positions.set(node.id, { x: col * (NODE_WIDTH + COL_GAP), y: lanes.indexOf(lane) * (NODE_HEIGHT + ROW_GAP) });
  }
  return { positions, lanes };
}

const EDGE_STYLE: Record<HistoryGraphEdge['kind'], { dash?: string; label: string }> = {
  parent: { label: 'parent commit' },
  'based-on': { dash: '6 4', label: 'snapshot based on this commit' },
  'verified-as': { dash: '2 3', label: 'commit shares the verified tree' },
};

export function SessionHistoryGraph({
  nodes,
  edges,
  selectedId,
  onSelect,
}: {
  nodes: HistoryGraphNode[];
  edges: HistoryGraphEdge[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { positions, lanes } = useMemo(() => layout(nodes, edges), [nodes, edges]);

  const flowNodes: Node[] = useMemo(
    () => [
      ...lanes.map((lane, row) => ({
        id: `lane:${lane}`,
        type: 'lane',
        position: { x: -LANE_LABEL_WIDTH - 16, y: row * (NODE_HEIGHT + ROW_GAP) },
        data: { label: lane },
        draggable: false,
        selectable: false,
        focusable: false,
      })),
      ...nodes.map((node) => ({
        id: node.id,
        type: 'history',
        position: positions.get(node.id) ?? { x: 0, y: 0 },
        data: { ...node, selected: node.id === selectedId },
        draggable: false,
      })),
    ],
    [nodes, lanes, positions, selectedId],
  );

  const flowEdges: Edge[] = useMemo(
    () =>
      edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: 'smoothstep',
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: 'hsl(var(--muted-foreground))' },
        style: {
          stroke: 'hsl(var(--muted-foreground))',
          strokeWidth: 1.5,
          strokeDasharray: EDGE_STYLE[edge.kind].dash,
        },
      })),
    [edges],
  );

  const presentKinds = useMemo(
    () => (Object.keys(EDGE_STYLE) as HistoryGraphEdge['kind'][]).filter((kind) => edges.some((edge) => edge.kind === kind)),
    [edges],
  );

  const height = Math.min(600, Math.max(260, lanes.length * (NODE_HEIGHT + ROW_GAP) + 96));

  if (nodes.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No history yet. A full verify records a content snapshot; a later commit on that same tree
        becomes a commit node.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <div className="overflow-hidden rounded-xl border bg-background" style={{ height }} data-testid="session-history-graph">
        <ReactFlow
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={nodeTypes}
          nodesConnectable={false}
          proOptions={{ hideAttribution: true }}
          fitView
          fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
          minZoom={0.3}
          maxZoom={1.4}
          onNodeClick={(_event, node) => {
            if (node.type === 'history') onSelect(node.id);
          }}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="hsl(var(--border))" />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      {presentKinds.length > 0 ? (
        <ul className="flex flex-wrap gap-4 text-xs text-muted-foreground" aria-label="Edge legend">
          {presentKinds.map((kind) => (
            <li key={kind} className="flex items-center gap-2">
              <svg width="28" height="8" aria-hidden>
                <line
                  x1="0"
                  y1="4"
                  x2="28"
                  y2="4"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeDasharray={EDGE_STYLE[kind].dash}
                />
              </svg>
              {EDGE_STYLE[kind].label}
            </li>
          ))}
          <li className="flex items-center gap-2">
            <span className="inline-block h-3 w-5 rounded border border-dashed" aria-hidden /> uncommitted snapshot
          </li>
        </ul>
      ) : null}
    </div>
  );
}
