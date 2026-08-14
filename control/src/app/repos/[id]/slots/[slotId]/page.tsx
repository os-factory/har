import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { SessionEventsTable } from '@/components/session-events-table';
import { SessionTimeline } from '@/components/session-timeline';
import { TrajectoryViewer } from '@/components/trajectory-viewer';
import { ValidationPipeline } from '@/components/validation-pipeline';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatAgentToolLabel } from '@/lib/agent-tool';
import { eventModel } from '@/lib/session-event-detail';
import { formatModelId, formatCostUsd, modelTotalsFromBreakdown, modelsFromBreakdown, type UsageModelTotals } from '@/lib/usage-models';
import { getRepository } from '@/server/repositories';
import { listSessionEventsForSlot } from '@/server/session-events';
import { getSlotTrajectoryData } from '@/server/trajectory-ledger';
import { listSessionUsageForSlot } from '@/server/usage';
import { getValidationStages } from '@/server/validation-stages';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export default async function SlotDetailPage({
  params,
}: {
  params: Promise<{ id: string; slotId: string }>;
}) {
  const { id, slotId: slotIdRaw } = await params;
  const slotId = Number(slotIdRaw);
  if (!Number.isFinite(slotId)) notFound();

  const repo = await getRepository(id);
  if (!repo) notFound();

  const slot = repo.slots.find((s) => s.slotId === slotId);
  if (!slot) notFound();

  const [usageRows, validation, events, verifyRuns, trajectory] = await Promise.all([
    listSessionUsageForSlot(id, slotId),
    getValidationStages(id, { agentId: slotId }),
    listSessionEventsForSlot(id, slotId),
    prisma.run.findMany({
      where: { repositoryId: id, stageId: 'verify', agentId: slotId },
      orderBy: { startedAt: 'desc' },
      take: 20,
    }),
    getSlotTrajectoryData(id, slotId),
  ]);

  const modelsByUsageKey = new Map<string, string[]>();
  for (const ev of events) {
    const model = eventModel(ev.attributes);
    if (!model) continue;
    const key = `${ev.sessionKey}::${ev.agentTool}`;
    const list = modelsByUsageKey.get(key) ?? [];
    if (!list.includes(model)) list.push(model);
    modelsByUsageKey.set(key, list);
  }

  const resolveModels = (sessionKey: string, agentTool: string, breakdown: unknown): string[] => {
    const stored = modelsFromBreakdown(breakdown);
    if (stored.length > 0) return stored;
    return (modelsByUsageKey.get(`${sessionKey}::${agentTool}`) ?? []).sort();
  };

  const totals = usageRows.reduce(
    (acc, row) => {
      acc.tokensInput += Number(row.tokensInput);
      acc.tokensOutput += Number(row.tokensOutput);
      acc.tokensCacheRead += Number(row.tokensCacheRead);
      acc.tokensCacheCreation += Number(row.tokensCacheCreation);
      acc.tokensTotal += Number(row.tokensTotal);
      if (row.costUsd != null) {
        acc.costUsd += Number(row.costUsd);
        acc.hasCost = true;
      }
      return acc;
    },
    {
      tokensInput: 0,
      tokensOutput: 0,
      tokensCacheRead: 0,
      tokensCacheCreation: 0,
      tokensTotal: 0,
      costUsd: 0,
      hasCost: false,
    },
  );

  return (
    <div className="space-y-6 px-4 py-4 md:px-6 md:py-6">
      <div>
        <Link href={`/repos/${id}`} className="text-sm text-muted-foreground hover:underline">
          ← {repo.path.split('/').pop() ?? repo.path}
        </Link>
        <h2 className="mt-2 text-2xl font-semibold">
          Slot {slotId}{' '}
          <span className="text-base font-normal text-muted-foreground">
            {slot.active ? '● Active' : '○ Idle'}
          </span>
        </h2>
        {slot.purpose && (
          <p className="text-sm text-muted-foreground" title={slot.purpose}>
            Summary: {slot.purpose}
          </p>
        )}
        <p className="mt-1 text-xs text-muted-foreground">
          Prompt text is included by default (opt out: `har telemetry on --no-prompts`).
          Usage and events stay in local SQLite.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Worktree</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="break-all font-mono text-xs text-muted-foreground">
              {slot.worktreePath ?? slot.workDir ?? '—'}
            </p>
            {slot.branch && (
              <p className="mt-2 font-mono text-xs" title={slot.baseCommit ?? undefined}>
                {!slot.active || !slot.worktreePath ? (
                  <span className="text-muted-foreground">last session · </span>
                ) : null}
                {slot.branch}
              </p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Total tokens</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold tabular-nums">{formatTokens(totals.tokensTotal)}</p>
            <p className="text-xs text-muted-foreground">
              in {formatTokens(totals.tokensInput)} · out {formatTokens(totals.tokensOutput)} ·
              cache {formatTokens(totals.tokensCacheRead + totals.tokensCacheCreation)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Estimated cost</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold tabular-nums">
              {totals.hasCost ? `$${totals.costUsd.toFixed(4)}` : '—'}
            </p>
            <p className="text-xs text-muted-foreground">
              Agent-reported USD when available; otherwise estimated via{' '}
              <a
                href="https://github.com/pydantic/genai-prices"
                className="underline underline-offset-2"
                target="_blank"
                rel="noreferrer"
              >
                genai-prices
              </a>
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Sessions recorded</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{usageRows.length}</p>
            <p className="text-xs text-muted-foreground">Includes historical (post-teardown) usage</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Verify</CardTitle>
          <CardDescription>
            Verification pipeline for this slot
            {validation?.latestRun &&
              ` — last verify ${validation.latestRun.startedAt.toLocaleString()} (${validation.latestRun.status})`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ValidationPipeline
            stages={validation?.stages ?? []}
            verifyRunCount={validation?.verifyRunCount ?? 0}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Session activity</CardTitle>
          <CardDescription>
            LLM usage and verify runs — model ids come from usage.modelBreakdown (OTEL
            gen_ai.request.model), with event fallback for older rows.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SessionTimeline
            usageRows={usageRows.map((row) => ({
              id: row.id,
              kind: 'usage' as const,
              sessionKey: row.sessionKey,
              agentTool: row.agentTool,
              tokensTotal: Number(row.tokensTotal),
              costUsd: row.costUsd == null ? null : Number(row.costUsd),
              sources: row.sources,
              models: resolveModels(row.sessionKey, row.agentTool, row.modelBreakdown),
              at: row.lastSeenAt,
            }))}
            verifyRuns={verifyRuns.map((run) => ({
              id: run.id,
              kind: 'verify' as const,
              runId: run.runId,
              status: run.status,
              at: run.startedAt,
            }))}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Agent activity</CardTitle>
          <CardDescription>
            Follow the assembled trajectory, or inspect the raw session-event table for debugging.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="trajectory">
            <TabsList>
              <TabsTrigger value="trajectory">Trajectory</TabsTrigger>
              <TabsTrigger value="raw-events">Raw events</TabsTrigger>
            </TabsList>
            <TabsContent value="trajectory" className="mt-4">
              <TrajectoryViewer
                repositoryId={id}
                agentId={slotId}
                streams={trajectory.streams}
                initialPage={trajectory.initialPage}
              />
            </TabsContent>
            <TabsContent value="raw-events" className="mt-4">
              <SessionEventsTable
                events={events.map((ev) => ({
                  id: ev.id,
                  eventName: ev.eventName,
                  sessionKey: ev.sessionKey,
                  agentTool: ev.agentTool,
                  promptText: ev.promptText,
                  responseText: ev.responseText,
                  attributes: ev.attributes,
                  rawTruncated: ev.rawTruncated,
                  source: ev.source,
                  timestamp: ev.timestamp,
                }))}
              />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Usage by agent</CardTitle>
          <CardDescription>
            Max-merged from OTEL ingest and sync harvest — per-model token totals and USD estimates
            (genai-prices) live on modelBreakdown for the portal
          </CardDescription>
        </CardHeader>
        <CardContent>
          {usageRows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No usage yet. Enable telemetry (`har telemetry on`), run Claude Code or Codex with
              OTEL pointed at Mission Control, or wait for `har control sync` harvest.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b text-muted-foreground">
                    <th className="py-2 pr-4 font-medium">Session</th>
                    <th className="py-2 pr-4 font-medium">Agent</th>
                    <th className="py-2 pr-4 font-medium">Models</th>
                    <th className="py-2 pr-4 font-medium">Tokens</th>
                    <th className="py-2 pr-4 font-medium">Cost</th>
                    <th className="py-2 pr-4 font-medium">Sources</th>
                    <th className="py-2 font-medium">Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  {usageRows.map((row) => {
                    const modelRows = modelTotalsFromBreakdown(row.modelBreakdown);
                    const models = resolveModels(row.sessionKey, row.agentTool, row.modelBreakdown);
                    return (
                      <tr key={row.id} className="border-b border-border/60">
                        <td className="max-w-xs truncate py-2 pr-4 font-mono text-xs" title={row.sessionKey}>
                          {row.sessionKey}
                        </td>
                        <td className="py-2 pr-4">
                          <Badge variant="outline">{formatAgentToolLabel(row.agentTool)}</Badge>
                        </td>
                        <td className="py-2 pr-4">
                          {modelRows.length === 0 && models.length === 0 ? (
                            <span className="text-muted-foreground">—</span>
                          ) : (
                            <div className="flex max-w-md flex-col gap-1">
                              {(modelRows.length > 0
                                ? modelRows
                                : models.map((model) => ({
                                    model,
                                    totals: {} as UsageModelTotals,
                                  }))
                              ).map(({ model, totals }) => (
                                <div key={model} className="flex flex-wrap items-center gap-1">
                                  <Badge
                                    variant="secondary"
                                    className="font-mono text-[10px]"
                                    title={model}
                                  >
                                    {formatModelId(model)}
                                  </Badge>
                                  {totals.costUsd != null ? (
                                    <span className="text-[10px] tabular-nums text-muted-foreground">
                                      {formatCostUsd(totals.costUsd)}
                                    </span>
                                  ) : null}
                                </div>
                              ))}
                            </div>
                          )}
                        </td>
                        <td className="py-2 pr-4 tabular-nums">
                          {formatTokens(Number(row.tokensTotal))}
                        </td>
                        <td className="py-2 pr-4 tabular-nums">
                          {formatCostUsd(row.costUsd == null ? null : Number(row.costUsd))}
                        </td>
                        <td className="py-2 pr-4">
                          <div className="flex flex-wrap gap-1">
                            {row.sources.map((s) => (
                              <Badge key={s} variant="secondary">
                                {s}
                              </Badge>
                            ))}
                          </div>
                        </td>
                        <td className="py-2 text-muted-foreground" suppressHydrationWarning>
                          {row.lastSeenAt.toLocaleString()}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
