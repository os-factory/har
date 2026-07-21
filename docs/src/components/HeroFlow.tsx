import { useEffect, useState } from 'react';
import {
  Background,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

type HarNodeData = {
  index?: string;
  title: string;
  subtitle: string;
  kind?: 'agent' | 'repository' | 'step' | 'evidence';
  status?: 'done' | 'live' | 'ready';
};

type HarNode = Node<HarNodeData, 'har'>;

const nodes: HarNode[] = [
  { id: 'agent', type: 'har', position: { x: 10, y: 28 }, data: { title: 'Agent', subtitle: 'requests task', kind: 'agent' } },
  { id: 'repo', type: 'har', position: { x: 190, y: 28 }, data: { title: 'Repository', subtitle: 'reads .har/', kind: 'repository' } },
  { id: 'slot', type: 'har', position: { x: 400, y: 28 }, data: { index: '01', title: 'Create slot', subtitle: 'isolated worktree', kind: 'step', status: 'done' } },
  { id: 'launch', type: 'har', position: { x: 400, y: 178 }, data: { index: '02', title: 'Launch stack', subtitle: 'ports + services', kind: 'step', status: 'done' } },
  { id: 'change', type: 'har', position: { x: 190, y: 178 }, data: { index: '03', title: 'Make changes', subtitle: 'inside worktree', kind: 'step', status: 'live' } },
  { id: 'verify', type: 'har', position: { x: 10, y: 178 }, data: { index: '04', title: 'Verify', subtitle: 'project checks', kind: 'step', status: 'done' } },
  { id: 'evidence', type: 'har', position: { x: 145, y: 326 }, data: { title: 'Validated branch', subtitle: 'logs · artifacts · tree hash', kind: 'evidence', status: 'ready' } },
];

const edges: Edge[] = [
  { id: 'agent-repo', source: 'agent', target: 'repo', sourceHandle: 'right', targetHandle: 'left', animated: true },
  { id: 'repo-slot', source: 'repo', target: 'slot', sourceHandle: 'right', targetHandle: 'left', animated: true },
  { id: 'slot-launch', source: 'slot', target: 'launch', sourceHandle: 'bottom', targetHandle: 'top', animated: true },
  { id: 'launch-change', source: 'launch', target: 'change', sourceHandle: 'left', targetHandle: 'right', animated: true },
  { id: 'change-verify', source: 'change', target: 'verify', sourceHandle: 'left', targetHandle: 'right', animated: true },
  { id: 'verify-evidence', source: 'verify', target: 'evidence', sourceHandle: 'bottom', targetHandle: 'left', animated: true, className: 'evidence-edge' },
  { id: 'change-evidence', source: 'change', target: 'evidence', sourceHandle: 'bottom', targetHandle: 'top', animated: true, className: 'evidence-edge' },
  { id: 'launch-evidence', source: 'launch', target: 'evidence', sourceHandle: 'bottom', targetHandle: 'right', animated: true, className: 'evidence-edge' },
];

function HarFlowNode({ data }: NodeProps<HarNode>) {
  const icon = data.kind === 'agent' ? 'A' : data.kind === 'repository' ? '⌘' : data.index;
  return (
    <div className={`rf-node rf-node-${data.kind ?? 'step'} ${data.status ? `is-${data.status}` : ''}`}>
      <Handle id="left" type="target" position={Position.Left} className="rf-handle" />
      <Handle id="right" type="source" position={Position.Right} className="rf-handle" />
      <Handle id="top" type="target" position={Position.Top} className="rf-handle" />
      <Handle id="bottom" type="source" position={Position.Bottom} className="rf-handle" />
      <span className="rf-node-icon">{data.kind === 'evidence' ? '✓' : icon}</span>
      <span className="rf-node-copy">
        <strong>{data.title}</strong>
        <small>{data.subtitle}</small>
      </span>
      {data.status === 'done' && <span className="rf-node-state">✓</span>}
      {data.status === 'live' && <span className="rf-node-live" aria-label="Active" />}
      {data.status === 'ready' && <span className="rf-node-pill">ready</span>}
    </div>
  );
}

const nodeTypes = { har: HarFlowNode };

function currentTheme(): 'light' | 'dark' {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

export default function HeroFlow() {
  const [colorMode, setColorMode] = useState<'light' | 'dark'>('dark');

  useEffect(() => {
    setColorMode(currentTheme());
    const observer = new MutationObserver(() => setColorMode(currentTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  return (
    <div className="flow-window">
      <div className="window-topbar">
        <div className="window-lights"><span /><span /><span /></div>
        <span className="window-label">agent-session / slot-03</span>
        <span className="window-status"><i /> running</span>
      </div>

      <div className="reactflow-shell desktop-flow">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          colorMode={colorMode}
          fitView
          fitViewOptions={{ padding: 0.08 }}
          minZoom={0.75}
          maxZoom={1.25}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          panOnDrag={false}
          zoomOnScroll={false}
          zoomOnPinch={false}
          zoomOnDoubleClick={false}
          preventScrolling={false}
          proOptions={{ hideAttribution: true }}
          defaultEdgeOptions={{
            type: 'smoothstep',
            markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12 },
          }}
          aria-label="HAR agent workflow"
        >
          <Background gap={18} size={1} />
        </ReactFlow>
      </div>

      <div className="flow-mobile mobile-flow">
        <div className="mobile-flow-step"><span>01</span><div><strong>Read the project contract</strong><small>Agent discovers the repository through <code>.har/</code></small></div></div>
        <i />
        <div className="mobile-flow-step"><span>02</span><div><strong>Create an isolated slot</strong><small>Fresh worktree, ports, services, and environment</small></div></div>
        <i />
        <div className="mobile-flow-step"><span>03</span><div><strong>Launch, change, verify</strong><small>Run the same workflow your team trusts</small></div></div>
        <i />
        <div className="mobile-flow-step mobile-flow-final"><span>✓</span><div><strong>Hand off evidence</strong><small>Logs, artifacts, exact validated tree hash</small></div></div>
      </div>

      <div className="flow-footer">
        <span><i /> deterministic workflow</span>
        <code>har env verify 3 --full</code>
      </div>
    </div>
  );
}
