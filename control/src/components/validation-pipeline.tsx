import type { ValidationStageStatus } from '@/server/validation-stages';
import { stageMeta, formatDuration, passRate } from '@/lib/stage-meta';
import { ValidationFlow } from '@/components/validation-flow';

function PipelineMetrics({
  stages,
  verifyRunCount,
}: {
  stages: ValidationStageStatus[];
  verifyRunCount: number;
}) {
  const withRuns = stages.filter((s) => s.runCount > 0);
  const passing = stages.filter((s) => s.lastStatus === 'pass').length;
  const totalLastMs = stages.reduce((sum, s) => sum + (s.lastMs ?? 0), 0);
  const avgPassRate =
    withRuns.length > 0
      ? Math.round(
          withRuns.reduce((sum, s) => sum + s.passCount / s.runCount, 0) / withRuns.length * 100,
        )
      : null;

  const metrics = [
    { label: 'Stages passing', value: stages.length > 0 ? `${passing}/${stages.length}` : '—' },
    { label: 'Last run total', value: totalLastMs > 0 ? formatDuration(totalLastMs) : '—' },
    { label: 'Avg pass rate', value: avgPassRate !== null ? `${avgPassRate}%` : '—' },
    { label: 'Verify runs', value: verifyRunCount > 0 ? String(verifyRunCount) : '—' },
  ];

  return (
    <dl className="mt-10 grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-4">
      {metrics.map((metric) => (
        <div key={metric.label} className="rounded-lg border bg-muted/30 px-4 py-3">
          <dt className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            {metric.label}
          </dt>
          <dd className="mt-1 text-xl font-semibold tabular-nums text-foreground">
            {metric.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function ValidationPipeline({
  stages,
  verifyRunCount = 0,
}: {
  stages: ValidationStageStatus[];
  verifyRunCount?: number;
}) {
  if (stages.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No validation stages declared for this repository yet. Declare them in the harness and
        re-sync.
      </p>
    );
  }

  return (
    <div data-testid="validation-pipeline">
      <ValidationFlow stages={stages} verifyRunCount={verifyRunCount} />
      <PipelineMetrics stages={stages} verifyRunCount={verifyRunCount} />
    </div>
  );
}

/** Per-stage timing grid shown below the pipeline flow. */
export function ValidationPipelineDetails({ stages }: { stages: ValidationStageStatus[] }) {
  if (stages.length === 0) return null;

  return (
    <dl className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 sm:gap-4">
      {stages.map((stage) => {
        const meta = stageMeta(stage.name);
        return (
          <div key={stage.name} className="rounded-lg border bg-muted/30 px-4 py-3">
            <dt className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              {meta.title}
            </dt>
            <dd className="mt-1 text-xl font-semibold tabular-nums text-foreground">
              {formatDuration(stage.lastMs)}
            </dd>
            <dd className="mt-0.5 text-xs text-muted-foreground">Pass rate {passRate(stage)}</dd>
          </div>
        );
      })}
    </dl>
  );
}
