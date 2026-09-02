import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { WorkTable, type WorkRow } from '@/components/work-table';
import { deriveWorkUnitState } from '@/lib/work-unit-state';
import { listFactoryWorkUnits } from '@/server/work-units';

export const dynamic = 'force-dynamic';

export default async function WorkPage() {
  const units = await listFactoryWorkUnits();
  const rows: WorkRow[] = units.map((unit) => {
    const outcome = unit.outcome as { decision?: string } | null;
    const latestRun = unit.runs[0];
    const cost = unit.usage.costUsd == null ? null : Number(unit.usage.costUsd);
    return {
      id: unit.id,
      workUnitId: unit.workUnitId,
      title: unit.title && unit.title !== unit.workUnitId ? unit.title : null,
      repoId: unit.repository.id,
      repoName: unit.repository.path.split('/').pop() ?? unit.repository.path,
      repoPath: unit.repository.path,
      state: deriveWorkUnitState({
        decision: outcome?.decision,
        hasActiveSlot: Boolean(unit.slot),
        hasFullProof: unit.validations.some((v) => v.status === 'pass' && v.full),
        latestRunStatus: latestRun?.status,
      }),
      activeSlotId: unit.slot?.slotId ?? null,
      attempts: unit.attempts.length,
      validations: unit.validationBindings.length,
      durationMs: unit.runs.reduce((sum, run) => sum + (run.durationMs ?? 0), 0),
      costUsd: cost,
      updatedAt: unit.sourceUpdatedAt,
      sourceUrl: unit.sourceUrl,
    };
  });

  return (
    <div className="min-w-0 space-y-6 overflow-x-hidden px-4 py-4 md:px-6 md:py-6">
      <div>
        <h2 className="text-2xl font-semibold">Work</h2>
        <p className="text-sm text-muted-foreground">
          Issues and tasks bound to harness sessions, with their attempts, proof and cost.
        </p>
      </div>
      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>Work units</CardTitle>
          <CardDescription>
            State is derived from execution evidence; only completion and abandonment are explicit.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <div className="rounded-lg border border-dashed p-8 text-center">
              <p className="font-medium">No bound work yet</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Launch with <code>har env launch 1 --work-id ISSUE-123</code> to bind a session to an issue.
              </p>
            </div>
          ) : (
            <WorkTable rows={rows} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
