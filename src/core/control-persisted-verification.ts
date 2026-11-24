import { selectSince } from './portal-watermark';
import { ChannelReadFailure, readControlPages, resolveControlRepoId } from './control-api-read';

/**
 * Verification runs Mission Control stored from the verification traces it
 * received (`GET /api/repos/:id/verification-runs`), as the HQ sync carries
 * them: the optional top-level `/api/sync` collection `verificationRuns`.
 */

export interface PortalVerificationStage {
  name: string;
  spanId: string;
  /** `cicd.pipeline.task.run.result`. */
  result: string;
  taskType?: string;
  startTime: string;
  endTime?: string;
}

export interface PortalVerificationRun {
  /** `cicd.pipeline.run.id`: the validation id (else the run id). */
  runId: string;
  traceId: string;
  spanId: string;
  pipelineName: string;
  /** `cicd.pipeline.result`. */
  result: string;
  verdict?: string;
  treeHash?: string;
  headRevision?: string;
  attestationDigest?: string;
  workUnitId?: string;
  attemptId?: string;
  branch?: string;
  producerVersion?: string;
  startTime: string;
  endTime?: string;
  stages: PortalVerificationStage[];
}

type Row = Record<string, unknown> & { id?: string; createdAt?: string };

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function withOptional<T extends object>(base: T, optional: Record<string, unknown>): T {
  const out = { ...base } as Record<string, unknown>;
  for (const [key, value] of Object.entries(optional)) {
    const text = optionalString(value);
    if (text !== undefined) out[key] = text;
  }
  return out as T;
}

export function toPortalVerificationRun(row: Row): PortalVerificationRun | null {
  const runId = optionalString(row.runId);
  const traceId = optionalString(row.traceId);
  const spanId = optionalString(row.spanId);
  const startTime = optionalString(row.startTime);
  if (!runId || !traceId || !spanId || !startTime) return null;
  const stages = Array.isArray(row.stages) ? (row.stages as Row[]) : [];
  return withOptional<PortalVerificationRun>(
    {
      runId,
      traceId,
      spanId,
      pipelineName: optionalString(row.pipelineName) ?? 'har verify',
      result: optionalString(row.result) ?? 'error',
      startTime,
      stages: stages.flatMap((stage) => {
        const name = optionalString(stage.name);
        const stageSpanId = optionalString(stage.spanId);
        const stageStart = optionalString(stage.startTime);
        if (!name || !stageSpanId || !stageStart) return [];
        return [
          withOptional<PortalVerificationStage>(
            { name, spanId: stageSpanId, result: optionalString(stage.result) ?? 'error', startTime: stageStart },
            { taskType: stage.taskType, endTime: stage.endTime },
          ),
        ];
      }),
    },
    {
      verdict: row.verdict,
      treeHash: row.treeHash,
      headRevision: row.headRevision,
      attestationDigest: row.attestationDigest,
      workUnitId: row.workUnitId,
      attemptId: row.attemptId,
      branch: row.branch,
      producerVersion: row.producerVersion,
      endTime: row.endTime,
    },
  );
}

export interface PersistedVerificationRuns {
  runs: PortalVerificationRun[];
  maxSyncedAt: string | null;
  failures: ChannelReadFailure[];
  truncated: string[];
}

/**
 * Runs stored since the watermark. A Mission Control without the endpoint
 * (older than this collection) answers 404: no runs, no failure.
 */
export async function fetchPersistedVerificationRuns(
  repoPath: string,
  apiUrl: string,
  since: string | null,
): Promise<PersistedVerificationRuns> {
  const empty: PersistedVerificationRuns = { runs: [], maxSyncedAt: null, failures: [], truncated: [] };
  const repo = await resolveControlRepoId(apiUrl, repoPath);
  if (!repo.ok) return { ...empty, failures: [{ channel: 'repos', reason: repo.error }] };
  if (!repo.data) return empty;

  const read = await readControlPages<Row>({
    url: `${apiUrl}/api/repos/${repo.data}/verification-runs`,
    since,
    rows: (data) => (data as { verificationRuns?: Row[] } | null)?.verificationRuns ?? [],
    cursor: (row) => ({ createdAt: row.createdAt, id: row.id }),
  });
  if (!read.ok) {
    if (read.error === 'HTTP 404') return empty;
    return { ...empty, failures: [{ channel: 'verification-runs', reason: read.error }] };
  }
  const selected = selectSince(read.rows, since, (row) => row.createdAt ?? null);
  return {
    runs: selected.selected.flatMap((row) => {
      const run = toPortalVerificationRun(row);
      return run ? [run] : [];
    }),
    maxSyncedAt: selected.maxSyncedAt,
    failures: [],
    truncated: read.truncated ? ['verification-runs'] : [],
  };
}
