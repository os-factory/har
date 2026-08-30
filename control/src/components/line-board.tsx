import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { LineBoard as LineBoardData } from '@/server/lines';

/**
 * Factory line board (#305) — the traveler for one installed line.
 *
 * A view over records Mission Control already has. It never runs a stage,
 * installs a bundle, or edits a tracker: `har line gate` and `har line add` own
 * those, and the handoff stays human.
 */

function stationTone(station: LineBoardData['stations'][number], isNext: boolean): string {
  if (station.green) return 'border-emerald-500/40 bg-emerald-500/5';
  if (station.failedStageIds.length > 0) return 'border-red-500/40 bg-red-500/5';
  if (isNext) return 'border-amber-500/40 bg-amber-500/5';
  return 'border-border';
}

function stationMark(station: LineBoardData['stations'][number], isNext: boolean): string {
  if (station.green) return '✓';
  if (station.failedStageIds.length > 0) return '✗';
  if (isNext) return '▶';
  return '·';
}

export function LineBoard({ board }: { board: LineBoardData }) {
  return (
    <Card data-testid={`line-board-${board.id}`}>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle>{board.title}</CardTitle>
          <Badge variant="outline">{board.id}</Badge>
          <Badge variant="secondary">{board.source}</Badge>
        </div>
        {board.description ? <CardDescription>{board.description}</CardDescription> : null}
      </CardHeader>

      <CardContent className="space-y-6">
        {/* The verify-pipeline callout: line stages are off verify BY DESIGN.
            Drawing them as missing verification stages would report a healthy
            pipeline as broken. */}
        {board.verifyLeaks.length > 0 ? (
          <p className="rounded-md border border-red-500/40 bg-red-500/5 p-3 text-sm">
            <strong>{board.verifyLeaks.join(', ')}</strong> {board.verifyLeaks.length === 1 ? 'is' : 'are'}{' '}
            listed in <code>verificationStages</code>. Line gate stages are opt-in — remove them
            from <code>.har/stages.json</code>, or ship the check as a verification plugin instead.
          </p>
        ) : (
          <p className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
            {board.registeredStageIds.length > 0 ? (
              <>
                <strong>{board.registeredStageIds.length}</strong> registered line{' '}
                {board.registeredStageIds.length === 1 ? 'stage' : 'stages'} (
                <code>{board.registeredStageIds.join(', ')}</code>) — none on the verify plan.
                Default <code>har env verify --full</code> is unaffected.
              </>
            ) : (
              <>This line registers no extra stages; its gate tags stages the harness already has.</>
            )}
            {board.optInEnv ? (
              <>
                {' '}
                Gate is opt-in via <code>{board.optInEnv}=1</code>.
              </>
            ) : null}
          </p>
        )}

        {/* The traveler: stations in order, earlier ones stay visible. */}
        <ol className="space-y-2">
          {board.stations.map((station) => {
            const isNext = station.id === board.nextStationId;
            return (
              <li
                key={station.id}
                data-testid={`line-station-${station.id}`}
                data-green={station.green ? 'true' : 'false'}
                className={`rounded-md border p-3 ${stationTone(station, isNext)}`}
              >
                <div className="flex flex-wrap items-baseline gap-2">
                  <span aria-hidden className="font-mono">
                    {stationMark(station, isNext)}
                  </span>
                  <span className="font-mono text-sm">{station.id}</span>
                  <span className="font-medium">{station.title}</span>
                  {isNext ? <Badge variant="outline">next</Badge> : null}
                  {station.work?.ids.length ? (
                    <Badge variant="secondary">
                      {station.work.source} {station.work.ids.join(', ')}
                    </Badge>
                  ) : null}
                </div>

                {station.description ? (
                  <p className="mt-1 text-sm text-muted-foreground">{station.description}</p>
                ) : null}

                <p className="mt-2 text-xs text-muted-foreground">
                  {station.requiredStageIds.length === 0 ? (
                    'no gate stages'
                  ) : (
                    <>
                      {station.passedStageIds.length}/{station.requiredStageIds.length} gate stages
                      green — <code>{station.requiredStageIds.join(', ')}</code>
                    </>
                  )}
                </p>

                {station.missingStageIds.length > 0 ? (
                  <p className="mt-1 text-xs text-red-500">
                    not registered: <code>{station.missingStageIds.join(', ')}</code>
                  </p>
                ) : null}
              </li>
            );
          })}
        </ol>

        {board.latestGateRuns.length > 0 ? (
          <div>
            <h3 className="mb-2 text-sm font-medium">Latest gate runs</h3>
            <ul className="space-y-1 text-sm">
              {board.latestGateRuns.map((run) => (
                <li key={run.stageId} className="flex flex-wrap items-center gap-2">
                  <Badge variant={run.status === 'pass' ? 'secondary' : 'destructive'}>
                    {run.status}
                  </Badge>
                  <code className="text-xs">{run.stageId}</code>
                  <span className="text-xs text-muted-foreground">
                    {new Date(run.startedAt).toLocaleString()}
                    {run.durationMs ? ` · ${(run.durationMs / 1000).toFixed(1)}s` : ''}
                    {run.agentId ? ` · agent ${run.agentId}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {board.slotsInFlight.length > 0 ? (
          <div>
            <h3 className="mb-2 text-sm font-medium">Workstations in use</h3>
            <ul className="space-y-1 text-sm">
              {board.slotsInFlight.map((slot) => (
                <li key={slot.slotId} className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">agent {slot.slotId}</Badge>
                  <code className="text-xs">{slot.branch ?? slot.workDir ?? 'unknown'}</code>
                  {slot.workUnitId ? (
                    <span className="text-xs text-muted-foreground">work {slot.workUnitId}</span>
                  ) : null}
                  {slot.purpose ? (
                    <span className="text-xs text-muted-foreground">{slot.purpose}</span>
                  ) : null}
                </li>
              ))}
            </ul>
            <p className="mt-1 text-xs text-muted-foreground">
              Occupied slots block a new launch — that is the poka-yoke, not a queue.
            </p>
          </div>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-3">
          <DeclaredList
            title="Skills"
            items={board.declared.skills.map((s) => `${s.id} (${s.role})`)}
          />
          <DeclaredList
            title="MCP servers"
            items={board.declared.mcp.map((m) => `${m.name}${m.required ? ' (required)' : ''}`)}
          />
          <DeclaredList title="Plugins" items={board.declared.plugins} />
        </div>

        <p className="text-xs text-muted-foreground">
          Declared, not installed — Mission Control reports what a station needs; it never
          installs skills or MCP servers. Agents hand off: this line ships nothing on its own.
        </p>
      </CardContent>
    </Card>
  );
}

function DeclaredList({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <h3 className="mb-1 text-sm font-medium">{title}</h3>
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground">none declared</p>
      ) : (
        <ul className="space-y-0.5 text-xs text-muted-foreground">
          {items.map((item) => (
            <li key={item}>
              <code>{item}</code>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
