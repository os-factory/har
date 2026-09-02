import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import type { ValidationStagesSummary } from '@/server/validation-stages';
import { timeAgo } from '@/lib/time';

/** One line that answers "is this slot verified, since when, and which stage failed". */
export function VerifySummary({
  validation,
  validationHref,
  showStages = true,
}: {
  validation: ValidationStagesSummary | null;
  validationHref: string;
  /** Hide the per-stage chips when a fuller pipeline view is rendered right below. */
  showStages?: boolean;
}) {
  const latest = validation?.latestRun ?? null;
  const stages = validation?.stages ?? [];

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm" data-testid="verify-summary">
      {latest ? (
        <>
          <Badge variant={latest.status === 'pass' ? 'success' : 'destructive'}>
            {latest.status === 'pass' ? 'Verified' : `Verify ${latest.status}`}
          </Badge>
          <span className="text-muted-foreground" title={latest.startedAt.toLocaleString()} suppressHydrationWarning>
            {timeAgo(latest.startedAt)}
          </span>
          <span className="text-muted-foreground">
            {validation?.verifyRunCount ?? 0} verify run{validation?.verifyRunCount === 1 ? '' : 's'}
          </span>
        </>
      ) : (
        <span className="text-muted-foreground">No verify run yet for this slot.</span>
      )}
      {showStages && stages.length > 0 && (
        <span className="flex flex-wrap gap-1" aria-label="Verification stages">
          {stages.map((stage) => (
            <Badge
              key={stage.name}
              variant={
                stage.lastStatus === 'pass'
                  ? 'success'
                  : stage.lastStatus === 'fail'
                    ? 'destructive'
                    : 'outline'
              }
              title={stage.lastStatus ? `${stage.name}: ${stage.lastStatus}` : `${stage.name}: not run`}
            >
              {stage.name}
            </Badge>
          ))}
        </span>
      )}
      <Link href={validationHref} className="text-xs underline underline-offset-2">
        Validation →
      </Link>
    </div>
  );
}
