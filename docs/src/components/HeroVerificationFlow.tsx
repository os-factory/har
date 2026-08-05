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

/** Must match `.reactflow-shell .rf-node { height }` in hero-flow.css */
const NODE_HEIGHT = 112;
const COL_GAP = 36;
const ROW_GAP = 40;
const FLOW_PADDING = 32;
const DESKTOP_NODE_WIDTH = 168;
const MOBILE_BREAKPOINT = 760;

const EDGE_COLOR = {
  fail: 'rgba(239, 108, 108, 0.72)',
};

interface FlowLayout {
  columns: number;
  nodeWidth: number;
  minZoom: number;
  maxZoom: number;
  shellHeight: number;
  contentWidth: number;
  fitToView: boolean;
  autoHeight: boolean;
}

function rowCount(stageCount: number, columns: number): number {
  return Math.max(1, Math.ceil(stageCount / columns));
}

function contentHeightFor(rows: number): number {
  if (rows <= 1) return NODE_HEIGHT + FLOW_PADDING * 2;
  return (rows - 1) * (NODE_HEIGHT + ROW_GAP) + NODE_HEIGHT + FLOW_PADDING * 2;
}

function contentWidthFor(columns: number, nodeWidth: number): number {
  if (columns <= 1) return nodeWidth + FLOW_PADDING * 2;
  return (columns - 1) * (nodeWidth + COL_GAP) + nodeWidth + FLOW_PADDING * 2;
}

function flowLayoutForWidth(width: number): FlowLayout {
  const stageCount = HERO_VERIFICATION_STAGES.length;

  if (width <= MOBILE_BREAKPOINT) {
    const columns = 1;
    const rows = rowCount(stageCount, columns);
    const nodeWidth = DESKTOP_NODE_WIDTH;

    return {
      columns,
      nodeWidth,
      minZoom: 1,
      maxZoom: 1,
      shellHeight: contentHeightFor(rows),
      contentWidth: contentWidthFor(columns, nodeWidth),
      fitToView: false,
      autoHeight: true,
    };
  }

  if (width <= 1080) {
    const columns = 2;
    const rows = rowCount(stageCount, columns);
    const nodeWidth = 148;
    return {
      columns,
      nodeWidth,
      minZoom: 0.55,
      maxZoom: 1,
      shellHeight: 480,
      contentWidth: contentWidthFor(columns, nodeWidth),
      fitToView: true,
      autoHeight: false,
    };
  }

  const columns = 3;
  const nodeWidth = DESKTOP_NODE_WIDTH;
  return {
    columns,
    nodeWidth,
    minZoom: 0.85,
    maxZoom: 1,
    shellHeight: 450,
    contentWidth: contentWidthFor(columns, nodeWidth),
    fitToView: true,
    autoHeight: false,
  };
}

function buildFlow(layout: FlowLayout): { nodes: Node[]; edges: Edge[] } {
  const stages = HERO_VERIFICATION_STAGES;
  const columns = Math.max(1, Math.min(stages.length, layout.columns));
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
      position: {
        x: FLOW_PADDING + col * nodeSpan,
        y: FLOW_PADDING + row * (NODE_HEIGHT + ROW_GAP),
      },
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

  return { nodes, edges };
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
    if (!layout.fitToView) return;

    const frame = requestAnimationFrame(() => {
      fitView({
        padding: layout.columns === 1 ? 0.06 : 0.1,
        minZoom: layout.minZoom,
        maxZoom: layout.maxZoom,
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
      className={`reactflow-shell${layout.autoHeight ? ' reactflow-shell--auto' : ''}`}
      style={{
        height: layout.shellHeight,
        ['--rf-node-width' as string]: `${layout.nodeWidth}px`,
        ['--rf-content-width' as string]: `${layout.contentWidth}px`,
      }}
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
        maxZoom={layout.maxZoom}
        defaultViewport={{ x: 0, y: 0, zoom: 1 }}
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="rgba(255,255,255,0.12)" />
        {layout.fitToView ? <FitViewOnLayout layout={layout} /> : null}
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
