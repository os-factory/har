import {
  StageKind,
  StageResult,
  StageResultSchema,
  VerificationResult,
  VerificationResultSchema,
} from '../harness/schema';

export function extractJsonFromOutput(output: string): unknown | null {
  const trimmed = output.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }

  const lines = trimmed.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line || !line.startsWith('{')) continue;
    try {
      return JSON.parse(line);
    } catch {
      // continue scanning
    }
  }

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }

  return null;
}

export function parseVerificationResult(stdout: string): VerificationResult | null {
  const json = extractJsonFromOutput(stdout);
  if (!json) return null;

  const parsed = VerificationResultSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/** Drop passing-step logs — they duplicate stderr progress and bloat CI/MCP context. */
export function slimVerificationResult(
  verification: VerificationResult | null | undefined,
): VerificationResult | null {
  if (!verification) return null;
  return {
    ...verification,
    stages: verification.stages.map((stage) => {
      if (!stage.pass || stage.output === undefined) return stage;
      const rest = { ...stage };
      delete rest.output;
      return rest;
    }),
  };
}

export function buildStageResult(input: {
  stageId: string;
  kind?: StageKind;
  agentId?: number;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs?: number;
  verification?: VerificationResult | null;
  previewUrls?: Record<string, string>;
}): StageResult {
  const verification = input.verification ?? parseVerificationResult(input.stdout) ?? undefined;
  const parsedStageResult = StageResultSchema.safeParse(extractJsonFromOutput(input.stdout));
  const pass = input.exitCode === 0 && (verification ? verification.status === 'pass' : true);
  const logs = [
    ...(input.stdout.trim()
      ? [{ stream: 'stdout' as const, content: input.stdout.trim() }]
      : []),
    ...(input.stderr.trim()
      ? [{ stream: 'stderr' as const, content: input.stderr.trim() }]
      : []),
  ];

  if (parsedStageResult.success) {
    return StageResultSchema.parse({
      ...parsedStageResult.data,
      status: pass ? parsedStageResult.data.status : 'fail',
      stageId: parsedStageResult.data.stageId ?? input.stageId,
      kind: parsedStageResult.data.kind ?? input.kind,
      code: parsedStageResult.data.code ?? input.exitCode,
      durationMs: parsedStageResult.data.durationMs ?? input.durationMs,
      logs: [...(parsedStageResult.data.logs ?? []), ...logs],
      data: {
        ...(typeof parsedStageResult.data.data === 'object' &&
        parsedStageResult.data.data !== null &&
        !Array.isArray(parsedStageResult.data.data)
          ? parsedStageResult.data.data
          : {}),
        agentId: input.agentId,
        verification,
      },
    });
  }

  return StageResultSchema.parse({
    status: pass ? 'pass' : 'fail',
    stageId: input.stageId,
    kind: input.kind,
    code: input.exitCode,
    durationMs: input.durationMs,
    logs,
    urls: input.previewUrls
      ? Object.entries(input.previewUrls).map(([label, url]) => ({ label, url }))
      : [],
    data: {
      agentId: input.agentId,
      verification,
    },
  });
}
