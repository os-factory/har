import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { LucideIcon } from 'lucide-react';

export interface HeroFlowNodeData extends Record<string, unknown> {
  index: number;
  title: string;
  subtitle: string;
  icon: LucideIcon;
  duration: string;
  status: 'pass' | 'fail';
  targetPosition: Position;
  sourcePosition: Position;
}

function HeroFlowNodeComponent({ data }: NodeProps) {
  const {
    index,
    title,
    subtitle,
    icon: Icon,
    duration,
    status,
    targetPosition,
    sourcePosition,
  } = data as HeroFlowNodeData;
  const passed = status === 'pass';

  return (
    <div className={`rf-node${passed ? ' rf-node-pass' : ' rf-node-fail'}`}>
      <Handle type="target" position={targetPosition} className="rf-handle" />
      <span className="rf-node-index">{String(index).padStart(2, '0')}</span>
      <span className="rf-node-icon" aria-hidden="true">
        <Icon size={14} strokeWidth={2} />
      </span>
      <div className="rf-node-copy">
        <strong>{title}</strong>
        <small>{subtitle}</small>
      </div>
      <span className="rf-node-duration">{duration}</span>
      {passed ? <span className="rf-node-state" aria-label="Passed">✓</span> : null}
      <Handle type="source" position={sourcePosition} className="rf-handle" />
    </div>
  );
}

export const HeroFlowNode = memo(HeroFlowNodeComponent);
