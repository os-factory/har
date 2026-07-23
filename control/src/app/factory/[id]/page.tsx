import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getFactoryWorkUnitById } from '@/server/work-units';

export const dynamic = 'force-dynamic';

export default async function WorkUnitPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const unit = await getFactoryWorkUnitById(id);
  if (!unit) notFound();
  const outcome = unit.outcome as { decision?: string; decidedAt?: string } | null;

  const timeline = [
    ...unit.attempts.map((attempt) => ({
      at: attempt.sourceCreatedAt,
      title: `Attempt ${attempt.attemptId.slice(0, 8)}`,
      detail: `slot ${attempt.agentId}${attempt.branch ? ` · ${attempt.branch}` : ''}`,
      state: 'attempt',
    })),
    ...unit.runs.map((run) => ({
      at: run.startedAt,
      title: run.stageId,
      detail: `${run.status}${run.durationMs ? ` · ${run.durationMs}ms` : ''}`,
      state: run.status,
    })),
    ...unit.validationBindings.map((binding) => ({
      at: binding.sourceCreatedAt,
      title: 'Exact-tree validation',
      detail: binding.treeHash,
      state: (() => {
        const validation = unit.validations.find(
          (candidate) => candidate.validationId === binding.validationId,
        );
        return validation?.status === 'pass' && validation.full
          ? 'verified'
          : validation?.status ?? 'validation';
      })(),
    })),
  ].sort((a, b) => b.at.getTime() - a.at.getTime());

  return (
    <div className="space-y-6 px-4 py-4 md:px-6 md:py-6">
      <div>
        <Link href="/" className="text-sm text-muted-foreground hover:underline">← Factory</Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h2 className="text-2xl font-semibold">{unit.title ?? unit.workUnitId}</h2>
          <Badge variant="secondary">{outcome?.decision ?? (unit.slot ? 'active' : 'open')}</Badge>
        </div>
        <p className="font-mono text-xs text-muted-foreground">{unit.workUnitId}</p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card><CardHeader><CardTitle className="text-base">Repository</CardTitle></CardHeader><CardContent className="break-all text-sm">{unit.repository.path}</CardContent></Card>
        <Card><CardHeader><CardTitle className="text-base">Attempts</CardTitle></CardHeader><CardContent className="text-2xl font-bold">{unit.attempts.length}</CardContent></Card>
        <Card><CardHeader><CardTitle className="text-base">Agent cost</CardTitle></CardHeader><CardContent className="text-2xl font-bold">${Number(unit.usage.costUsd ?? 0).toFixed(4)}</CardContent></Card>
      </div>

      <Card>
        <CardHeader><CardTitle>Evidence timeline</CardTitle></CardHeader>
        <CardContent>
          {timeline.length === 0 ? <p className="text-sm text-muted-foreground">No execution evidence synchronized yet.</p> : (
            <ol className="space-y-4">
              {timeline.map((item, index) => (
                <li key={`${item.title}-${item.at.toISOString()}-${index}`} className="border-l pl-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium">{item.title}</p>
                    <Badge variant={item.state === 'fail' || item.state === 'error' ? 'destructive' : 'outline'}>{item.state}</Badge>
                  </div>
                  <p className="break-all font-mono text-xs text-muted-foreground">{item.detail}</p>
                  <time className="text-xs text-muted-foreground">{item.at.toLocaleString()}</time>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
