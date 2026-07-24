import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { listFactoryWorkUnits } from '@/server/work-units';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const units = await listFactoryWorkUnits();
  const completed = units.filter((unit) => {
    const outcome = unit.outcome as { decision?: string } | null;
    return outcome?.decision === 'completed';
  }).length;
  const active = units.filter((unit) => unit.slot).length;
  const verified = units.filter((unit) =>
    unit.validations.some((validation) => validation.status === 'pass' && validation.full),
  ).length;

  return (
    <div className="min-w-0 space-y-6 overflow-x-hidden px-4 py-4 md:px-6 md:py-6">
      <div>
        <h2 className="text-2xl font-semibold">Factory</h2>
        <p className="text-sm text-muted-foreground">
          Durable work identity joined to attempts, exact-tree proof, time, and cost.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        {[
          ['Work units', units.length],
          ['Active attempts', active],
          ['Verified / completed', `${verified} / ${completed}`],
        ].map(([label, value]) => (
          <Card key={String(label)}>
            <CardHeader><CardTitle className="text-base">{label}</CardTitle></CardHeader>
            <CardContent><p className="text-2xl font-bold">{value}</p></CardContent>
          </Card>
        ))}
      </div>

      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>Work</CardTitle>
          <CardDescription>
            State is derived from execution evidence; only completion and abandonment are explicit.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {units.length === 0 ? (
            <div className="rounded-lg border border-dashed p-8 text-center">
              <p className="font-medium">No bound work yet</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Launch with <code>har env launch 1 --work-id ISSUE-123</code>. Existing unbound repositories continue to work normally.
              </p>
              <Link className="mt-4 inline-block text-sm underline" href="/worktrees">View operations</Link>
            </div>
          ) : units.map((unit) => {
            const outcome = unit.outcome as { decision?: string } | null;
            const latestRun = unit.runs[0];
            const hasFullProof = unit.validations.some((validation) => validation.status === 'pass' && validation.full);
            const state = outcome?.decision ?? (unit.slot ? 'active' : hasFullProof ? 'verified' : latestRun?.status === 'fail' || latestRun?.status === 'error' ? 'failed' : 'pending');
            return (
              <Link key={unit.id} href={`/factory/${unit.id}`} className="block rounded-lg border p-4 transition-colors hover:bg-muted/50">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-medium">{unit.title ?? unit.workUnitId}</p>
                    <p className="font-mono text-xs text-muted-foreground">{unit.workUnitId} · {unit.repository.path}</p>
                  </div>
                  <Badge variant={state === 'failed' ? 'destructive' : 'secondary'}>{state}</Badge>
                </div>
                <div className="mt-3 flex flex-wrap gap-4 text-xs text-muted-foreground">
                  <span>{unit.attempts.length} attempt{unit.attempts.length === 1 ? '' : 's'}</span>
                  <span>{unit.validationBindings.length} validation{unit.validationBindings.length === 1 ? '' : 's'}</span>
                  <span>{unit.runs.reduce((sum, run) => sum + (run.durationMs ?? 0), 0)} ms</span>
                  <span>{Number(unit.usage.costUsd ?? 0).toFixed(4)} USD</span>
                </div>
              </Link>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
