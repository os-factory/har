'use client';

import { useMemo } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  type Edge,
  type Node,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { HistoryGraphEdge, HistoryGraphNode } from '@har/schemas';
import { cn } from '@/lib/utils';

const NODE_WIDTH = 220;
const NODE_HEIGHT = 96;
const COL_GAP = 72;
const ROW_GAP = 56;

function short(value: string | undefined): string {
  if (!value) return '—';
  return value.length > 10 ? value.slice(0, 10) : value;
}

function HistoryNode({
  data,
}: {
  data: HistoryGraphNode & { selected?: boolean };
}) {
  const pending = data.pending;
  return (
    <div
      className={cn(
        'w-[220px] rounded-xl border bg-card px-3 py-2.5',
        pending && 'border-dashed',
        data.status === 'pass' && data.full && 'border-emerald-500/50',
        data.status === 'fail' && 'border-destructive/50',
        data.selected && 'ring-2 ring-primary',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {pending ? 'Pending snapshot' : 'Commit'}
        </span>
        {data.full && data.status === 'pass' && (
          <span className="text-[10px] font-medium text-emerald-700 dark:text-emerald-400">
            Verified
          </span>
        )}
      </div>
      <p className="mt-1 font-mono text-sm">{short(data.commitSha ?? data.treeHash)}</p>
      <p className="mt-0.5 truncate text-xs text-muted-foreground">
        {data.message ?? data.branch ?? 'content snapshot'}
      </p>
    </div>
  );
}

const nodeTypes: NodeTypes = {
  history: HistoryNode as unknown as NodeTypes[string],
};

function layout(nodes: HistoryGraphNode[]): Map<string, { x: number; y: number }> {
  const lanes = new Map<string, HistoryGraphNode[]>();
  for (const node of nodes) {
    const lane = node.branch ?? (node.pending ? 'pending' : 'history');
    const list = lanes.get(lane) ?? [];
    list.push(node);
    lanes.set(lane, list);
  }
  const positions = new Map<string, { x: number; y: number }>();
  [...lanes.entries()].forEach(([, list], row) => {
    list.forEach((node, col) => {
      positions.set(node.id, { x: col * (NODE_WIDTH + COL_GAP), y: row * (NODE_HEIGHT + ROW_GAP) });
    });
  });
  return positions;
}

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
  const positions = useMemo(() => layout(nodes), [nodes]);
  const flowNodes: Node[] = useMemo(
    () =>
      nodes.map((node) => ({
        id: node.id,
        type: 'history',
        position: positions.get(node.id) ?? { x: 0, y: 0 },
        data: { ...node, selected: node.id === selectedId },
        draggable: false,
      })),
    [nodes, positions, selectedId],
  );
  const flowEdges: Edge[] = useMemo(
    () =>
      edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: 'smoothstep',
        animated: edge.kind === 'based-on',
        style: { stroke: 'hsl(var(--muted-foreground))' },
      })),
    [edges],
  );

  const height = Math.min(520, Math.max(220, new Set(nodes.map((node) => node.branch ?? 'x')).size * (NODE_HEIGHT + ROW_GAP) + 80));

  if (nodes.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No session history yet. Full verify records a content snapshot; a later commit on that
        same tree becomes a commit node.
      </p>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border bg-background" style={{ height }} data-testid="session-history-graph">
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        nodesConnectable={false}
        proOptions={{ hideAttribution: true }}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
        minZoom={0.4}
        maxZoom={1.4}
        onNodeClick={(_event, node) => onSelect(node.id)}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="hsl(var(--border))" />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
