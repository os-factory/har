import { useEffect, useMemo, useState } from 'react';
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

const NODE_HEIGHT = 92;
const COL_GAP = 36;
const ROW_GAP = 40;

const EDGE_COLOR = {
  fail: 'rgba(239, 108, 108, 0.72)',
};

interface FlowLayout {
  columns: number;
  nodeWidth: number;
  minZoom: number;
  shellHeight: number;
}

function flowLayoutForWidth(width: number): FlowLayout {
  if (width <= 480) {
    return { columns: 1, nodeWidth: 136, minZoom: 0.42, shellHeight: 520 };
  }
  if (width <= 760) {
    return { columns: 2, nodeWidth: 148, minZoom: 0.55, shellHeight: 480 };
  }
  return { columns: 3, nodeWidth: 168, minZoom: 0.85, shellHeight: 450 };
}

function buildFlow(layout: FlowLayout): { nodes: Node[]; edges: Edge[]; rows: number } {
  const stages = HERO_VERIFICATION_STAGES;
  const columns = Math.max(1, Math.min(stages.length, layout.columns));
  const rows = Math.max(1, Math.ceil(stages.length / columns));
  const nodeSpan = layout.nodeWidth + COL_GAP;

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
      position: { x: col * nodeSpan, y: row * (NODE_HEIGHT + ROW_GAP) },
      data,
      draggable: false,
      selectable: false,
      sourcePosition,
      targetPosition,
    };
  });

  const edges: Edge[] = stages.slice(0, -1).map((stage, index) => {
    const next = stages[index + 1];
    const color = stage.status === 'pass' ? 'var(--flow-edge)' : EDGE_COLOR.fail;
    return {
      id: `${stage.id}->${next.id}`,
      source: stage.id,
      target: next.id,
      type: 'straight',
      animated: stage.status === 'pass',
      style: { stroke: color },
    };
  });

  return { nodes, edges, rows };
}

function useFlowLayout(): FlowLayout {
  const [layout, setLayout] = useState<FlowLayout>(() =>
    typeof window === 'undefined' ? flowLayoutForWidth(1200) : flowLayoutForWidth(window.innerWidth),
  );

  useEffect(() => {
    const update = () => setLayout(flowLayoutForWidth(window.innerWidth));
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  return layout;
}

function FitViewOnLayout({ layout }: { layout: FlowLayout }) {
  const { fitView } = useReactFlow();

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      fitView({
        padding: layout.columns === 1 ? 0.06 : 0.1,
        minZoom: layout.minZoom,
        maxZoom: 1,
        duration: 0,
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [fitView, layout]);

  return null;
}

function HeroVerificationFlowCanvas() {
  const layout = useFlowLayout();
  const { nodes, edges } = useMemo(() => buildFlow(layout), [layout]);

  return (
    <div
      className="reactflow-shell"
      style={{ height: layout.shellHeight, ['--rf-node-width' as string]: `${layout.nodeWidth}px` }}
    >
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
        minZoom={layout.minZoom}
        maxZoom={1}
        defaultViewport={{ x: 0, y: 0, zoom: 1 }}
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="rgba(255,255,255,0.12)" />
        <FitViewOnLayout layout={layout} />
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
