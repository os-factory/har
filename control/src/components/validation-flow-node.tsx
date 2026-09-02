'use client';

import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { CheckCircle2, XCircle, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface StageNodeData extends Record<string, unknown> {
  index: number;
  title: string;
  subtitle: string;
  icon: LucideIcon;
  status: 'pass' | 'fail' | null;
  duration: string;
  passRate: string;
  targetPosition: Position;
  sourcePosition: Position;
}

function dotClass(status: StageNodeData['status']) {
  if (status === 'pass') return '!bg-emerald-500';
  if (status === 'fail') return '!bg-destructive';
  return '!bg-muted-foreground/40';
}

function StageNodeComponent({ data }: NodeProps) {
  const {
    index,
    title,
    subtitle,
    icon: Icon,
    status,
    duration,
    passRate,
    targetPosition,
    sourcePosition,
  } = data as StageNodeData;
  const passed = status === 'pass';
  const failed = status === 'fail';

  return (
    <div
      className={cn(
        'w-[200px] rounded-xl border bg-card px-3.5 py-3 shadow-sm',
        passed && 'border-emerald-500/50 bg-emerald-500/[0.05] dark:border-emerald-500/30 dark:bg-emerald-500/[0.02]',
        failed && 'border-destructive/50 bg-destructive/[0.05]',
        !passed && !failed && 'bg-muted/20',
      )}
    >
      <Handle
        type="target"
        position={targetPosition}
        className={cn('!h-2.5 !w-2.5 !border-2 !border-background', dotClass(status))}
      />

      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {String(index).padStart(2, '0')}
        </span>
        {passed && <CheckCircle2 className="size-3.5 text-emerald-600 dark:text-emerald-400" aria-label="Passed" />}
        {failed && <XCircle className="size-3.5 text-destructive" aria-label="Failed" />}
      </div>

      <div className="mt-2 flex items-center gap-2.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
          <Icon className="size-4 text-foreground" />
        </span>
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-foreground">{title}</h3>
          <p className="truncate text-[11px] text-muted-foreground">{subtitle}</p>
        </div>
      </div>

      <div className="mt-2.5 flex items-center justify-between border-t border-border/60 pt-2 font-mono text-[11px] tabular-nums text-muted-foreground">
        <span>{duration}</span>
        <span title="Passes / verify runs counted for this view">{passRate}</span>
      </div>

      <Handle
        type="source"
        position={sourcePosition}
        className={cn('!h-2.5 !w-2.5 !border-2 !border-background', dotClass(status))}
      />
    </div>
  );
}

export const StageNode = memo(StageNodeComponent);
