import { useEffect, useMemo } from 'react';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Position,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './hero-flow.css';
import { HERO_VERIFICATION_STAGES, formatStageDuration } from '../lib/hero-stage-meta';
import { HeroFlowNode, type HeroFlowNodeData } from './HeroFlowNode';

const nodeTypes: NodeTypes = { stage: HeroFlowNode };

const NODE_WIDTH = 168;
const NODE_HEIGHT = 92;
const COL_GAP = 36;
const ROW_GAP = 40;
const MAX_COLS = 3;

const EDGE_COLOR = {
  pass: 'rgba(125, 202, 162, 0.62)',
  fail: 'rgba(239, 108, 108, 0.72)',
};

function buildFlow(): { nodes: Node[]; edges: Edge[]; rows: number } {
  const stages = HERO_VERIFICATION_STAGES;
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

    const data: HeroFlowNodeData = {
      index: index + 1,
      title: stage.title,
      subtitle: stage.subtitle,
      icon: stage.icon,
      duration: formatStageDuration(stage.durationMs),
      status: stage.status,
      sourcePosition,
      targetPosition,
    };

    return {
      id: stage.id,
      type: 'stage',
      position: { x: col * (NODE_WIDTH + COL_GAP), y: row * (NODE_HEIGHT + ROW_GAP) },
      data,
      draggable: false,
      selectable: false,
      sourcePosition,
      targetPosition,
    };
  });

  const edges: Edge[] = stages.slice(0, -1).map((stage, index) => {
    const next = stages[index + 1];
    const color = stage.status === 'pass' ? EDGE_COLOR.pass : EDGE_COLOR.fail;
    return {
      id: `${stage.id}->${next.id}`,
      source: stage.id,
      target: next.id,
      type: 'smoothstep',
      animated: stage.status === 'pass',
      style: { stroke: color },
    };
  });

  return { nodes, edges, rows };
}

function FitViewOnMount() {
  const { fitView } = useReactFlow();

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      fitView({ padding: 0.12, minZoom: 1, maxZoom: 1, duration: 0 });
    });
    return () => cancelAnimationFrame(frame);
  }, [fitView]);

  return null;
}

function HeroVerificationFlowCanvas() {
  const { nodes, edges, rows } = useMemo(() => buildFlow(), []);
  const height = Math.min(450, Math.max(320, rows * (NODE_HEIGHT + ROW_GAP) + 80));

  return (
    <div className="reactflow-shell" style={{ height }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        nodesConnectable={false}
        elementsSelectable={false}
        nodesDraggable={false}
        onlyRenderVisibleElements={false}
        panOnDrag={false}
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        preventScrolling={false}
        proOptions={{ hideAttribution: true }}
        minZoom={1}
        maxZoom={1}
        defaultViewport={{ x: 0, y: 0, zoom: 1 }}
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="rgba(255,255,255,0.12)" />
        <FitViewOnMount />
      </ReactFlow>
    </div>
  );
}

export default function HeroVerificationFlow() {
  return (
    <ReactFlowProvider>
      <HeroVerificationFlowCanvas />
    </ReactFlowProvider>
  );
}
