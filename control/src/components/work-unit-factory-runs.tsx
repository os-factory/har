import { Badge } from '@/components/ui/badge';
import { shortDigest } from '@/lib/factory-proof';
import { formatDurationMs } from '@/lib/work-unit-state';
import type { AttemptView, EvidenceLinkView, UsageView } from '@/server/work-unit-view';

/**
 * The work unit view (ADR 0005 section 3) as Mission Control receives it from
 * ingest v2: per attempt, its factory runs with their stages and evidence, the
 * proof, the commits, and usage up to each run's end. Records only: nothing
 * here links a slot (#348).
 */

function statusVariant(status: string | null): 'success' | 'destructive' | 'secondary' {
  if (status === 'pass' || status === 'passed' || status === 'success') return 'success';
  if (status === 'fail' || status === 'failed' || status === 'failure' || status === 'error') return 'destructive';
  return 'secondary';
}

function EvidenceLink({ link }: { link: EvidenceLinkView }) {
  const label = link.name ?? `${link.sha256.slice(0, 12)}…`;
  return (
    <span className="inline-flex min-w-0 items-center gap-1 font-mono text-xs" title={`sha256:${link.sha256}`}>
      {link.stored ? (
        <a href={link.href} target="_blank" rel="noreferrer" className="truncate text-primary underline-offset-2 hover:underline">
          {label}
        </a>
      ) : (
        <span className="truncate text-muted-foreground">{label}</span>
      )}
      <span className="text-muted-foreground">sha256:{link.sha256.slice(0, 8)}…</span>
      {link.stored ? null : <span className="text-muted-foreground">(not uploaded)</span>}
    </span>
  );
}

function formatCost(costUsd: number | null): string {
  if (costUsd == null) return '—';
  return `$${costUsd < 0.01 ? costUsd.toFixed(4) : costUsd.toFixed(2)}`;
}

function UsageTable({ usage }: { usage: UsageView }) {
  if (usage.byModel.length === 0) return <p className="text-xs text-muted-foreground">No usage stamped with this attempt.</p>;
  return (
    <table className="w-full text-left text-xs" data-testid="factory-run-usage">
      <thead className="text-muted-foreground">
        <tr>
          <th className="py-1 pr-2 font-medium">Model</th>
          <th className="py-1 pr-2 text-right font-medium">Tokens</th>
          <th className="py-1 pr-2 text-right font-medium">Cost</th>
          <th className="py-1 font-medium">Priced with</th>
        </tr>
      </thead>
      <tbody>
        {usage.byModel.map((model) => (
          <tr key={`${model.agentTool}:${model.model ?? ''}`} className="border-t">
            <td className="py-1 pr-2 font-mono">{model.model ?? model.agentTool}</td>
            <td className="py-1 pr-2 text-right tabular-nums">{model.tokensTotal.toLocaleString('en-US')}</td>
            <td className="py-1 pr-2 text-right tabular-nums">
              {formatCost(model.costUsd)}
              {model.costSource && model.costSource !== 'reported' ? ` ${model.costSource === 'estimated' ? 'est.' : 'mixed'}` : ''}
            </td>
            <td className="py-1 font-mono text-muted-foreground">
              {model.costSource === 'reported' ? 'reported' : model.pricedWith.join(', ') || '—'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function WorkUnitFactoryRuns({ attempts }: { attempts: AttemptView[] }) {
  const runs = attempts.flatMap((attempt) => attempt.factoryRuns.map((run) => ({ attempt, run })));
  if (runs.length === 0) {
    return <p className="text-sm text-muted-foreground">No factory run received for this work unit yet.</p>;
  }
  return (
    <div className="space-y-4" data-testid="work-unit-factory-runs">
      {attempts.map((attempt) =>
        attempt.factoryRuns.length === 0 ? null : (
          <section key={attempt.attemptId} className="min-w-0 space-y-3">
            <p className="text-xs text-muted-foreground">
              Attempt <span className="font-mono">{attempt.attemptId}</span> · slot {attempt.slotId}
              {attempt.branch ? <> · <span className="font-mono">{attempt.branch}</span></> : null}
              {attempt.usage.costUsd != null ? <> · {formatCost(attempt.usage.costUsd)} total</> : null}
            </p>
            {[...attempt.factoryRuns].reverse().map((run) => (
              <article key={run.factoryRunId} className="min-w-0 rounded-lg border p-3" data-testid="factory-run">
                <header className="flex flex-wrap items-center gap-2">
                  <Badge variant={statusVariant(run.verdict ?? run.status)}>{run.verdict ?? run.status ?? 'unknown'}</Badge>
                  <span className="font-mono text-xs" title="Factory run id">{run.factoryRunId}</span>
                  <span className="font-mono text-xs text-muted-foreground" title={`tree ${run.tree}`}>
                    tree {run.tree.slice(0, 8)}
                  </span>
                  {run.factoryLine ? (
                    <span className="text-xs text-muted-foreground">
                      {run.factoryLine}
                      {run.station ? ` / ${run.station}` : ''}
                    </span>
                  ) : null}
                  {run.finishedAt ? (
                    <span className="ml-auto text-xs text-muted-foreground" suppressHydrationWarning>
                      {new Date(run.finishedAt).toLocaleString()}
                    </span>
                  ) : null}
                </header>
                {run.stages.length ? (
                  <ul className="mt-2 space-y-1" data-testid="factory-run-stages">
                    {run.stages.map((stage) => (
                      <li key={stage.stageId} className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
                        <Badge variant={statusVariant(stage.status)} className="font-mono text-[11px]">
                          {stage.status}
                        </Badge>
                        <span className="font-mono text-xs">{stage.stageId}</span>
                        {stage.durationMs != null ? (
                          <span className="text-xs text-muted-foreground">{formatDurationMs(stage.durationMs)}</span>
                        ) : null}
                        {stage.log ? <EvidenceLink link={stage.log} /> : null}
                        {stage.artifacts
                          .filter((artifact) => artifact.sha256 !== stage.log?.sha256)
                          .map((artifact) => (
                            <EvidenceLink key={artifact.sha256} link={artifact} />
                          ))}
                      </li>
                    ))}
                  </ul>
                ) : null}
                <dl className="mt-2 grid gap-2 text-xs sm:grid-cols-2">
                  <div className="min-w-0">
                    <dt className="text-muted-foreground">Proof</dt>
                    <dd className="font-mono" data-testid="factory-run-proof">
                      {run.proof ? (
                        <a href={run.proof.href} className="text-primary underline-offset-2 hover:underline" title={run.proof.statementDigest}>
                          {shortDigest(run.proof.statementDigest)}
                        </a>
                      ) : (
                        '—'
                      )}
                      {run.proof?.trust ? <span className="text-muted-foreground"> · {run.proof.trust}</span> : null}
                    </dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-muted-foreground">Commits</dt>
                    <dd className="font-mono">
                      {run.commits.length ? run.commits.map((commit) => commit.commitSha.slice(0, 8)).join(', ') : '—'}
                    </dd>
                  </div>
                </dl>
                <div className="mt-2">
                  <p className="text-xs text-muted-foreground">
                    Usage up to this run{run.trajectoryEvents ? ` · ${run.trajectoryEvents} trajectory events` : ''}
                  </p>
                  <UsageTable usage={run.usage} />
                </div>
              </article>
            ))}
          </section>
        ),
      )}
    </div>
  );
}
