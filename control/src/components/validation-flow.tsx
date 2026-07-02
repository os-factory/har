'use client';

import { useMemo } from 'react';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Position,
  type Edge,
  type Node,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './validation-flow.css';
import type { ValidationStageStatus } from '@/server/validation-stages';
import { stageMeta, formatDuration, passRate } from '@/lib/stage-meta';
import { StageNode, type StageNodeData } from './validation-flow-node';

const nodeTypes: NodeTypes = { stage: StageNode };

const NODE_WIDTH = 200;
const NODE_HEIGHT = 108;
const COL_GAP = 64;
const ROW_GAP = 48;
const MAX_COLS = 5;

const STATUS_COLOR: Record<'pass' | 'fail' | 'none', string> = {
  pass: '#10b981',
  fail: 'hsl(var(--destructive))',
  none: 'hsl(var(--muted-foreground) / 0.5)',
};

function statusKey(status: 'pass' | 'fail' | null): 'pass' | 'fail' | 'none' {
  return status ?? 'none';
}

/** Lay out stages in a wrapping "snake" grid — rows alternate direction so
 *  the flow reads left-to-right then right-to-left, like a wiring diagram.
 *  Keeps the canvas readable as more stages are declared over time. */
function buildFlow(stages: ValidationStageStatus[]): { nodes: Node[]; edges: Edge[]; rows: number } {
  const columns = Math.max(1, Math.min(stages.length, MAX_COLS));
  const rows = Math.max(1, Math.ceil(stages.length / columns));

  const nodes: Node[] = stages.map((stage, index) => {
    const row = Math.floor(index / columns);
    const colInRow = index % columns;
    const leftToRight = row % 2 === 0;
    const col = leftToRight ? colInRow : columns - 1 - colInRow;

    const wrapsToNextRow = colInRow === columns - 1 && index < stages.length - 1;
    const wrapsFromPrevRow = colInRow === 0 && row > 0;

    const sourcePosition = wrapsToNextRow ? Position.Bottom : leftToRight ? Position.Right : Position.Left;
    const targetPosition = wrapsFromPrevRow ? Position.Top : leftToRight ? Position.Left : Position.Right;

    const meta = stageMeta(stage.name);
    const data: StageNodeData = {
      index: index + 1,
      title: meta.title,
      subtitle: meta.subtitle,
      icon: meta.icon,
      status: stage.lastStatus,
      duration: formatDuration(stage.lastMs),
      passRate: passRate(stage),
      sourcePosition,
      targetPosition,
    };

    return {
      id: stage.name,
      type: 'stage',
      position: { x: col * (NODE_WIDTH + COL_GAP), y: row * (NODE_HEIGHT + ROW_GAP) },
      data,
      draggable: true,
      selectable: false,
      sourcePosition,
      targetPosition,
    };
  });

  const edges: Edge[] = stages.slice(0, -1).map((stage, index) => {
    const next = stages[index + 1];
    const color = STATUS_COLOR[statusKey(stage.lastStatus)];
    return {
      id: `${stage.name}->${next.name}`,
      source: stage.name,
      target: next.name,
      type: 'smoothstep',
      animated: stage.lastStatus === 'pass',
      style: { stroke: color },
    };
  });

  return { nodes, edges, rows };
}

export function ValidationFlow({ stages }: { stages: ValidationStageStatus[] }) {
  const { nodes, edges, rows } = useMemo(() => buildFlow(stages), [stages]);
  const height = Math.min(560, Math.max(240, rows * (NODE_HEIGHT + ROW_GAP) + 96));

  return (
    <div
      className="har-flow-canvas overflow-hidden rounded-xl border bg-background"
      style={{ height }}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        nodesConnectable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: true }}
        fitView
        fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
        minZoom={0.4}
        maxZoom={1.5}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="hsl(var(--border))" />
        <Controls showInteractive={false} />
        <MiniMap
          pannable
          zoomable
          nodeColor={(node) => STATUS_COLOR[statusKey((node.data as StageNodeData).status)]}
          maskColor="hsl(var(--background) / 0.6)"
          bgColor="hsl(var(--muted) / 0.3)"
        />
      </ReactFlow>
    </div>
  );
}
