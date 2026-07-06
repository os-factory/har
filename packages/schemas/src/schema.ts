import { z } from 'zod';

export const HAR_STAGE_KINDS = [
  'setup',
  'launch',
  'verify',
  'test',
  'inspect',
  'reset',
  'teardown',
  'custom',
] as const;

/** Absolute minimum agent slot id; per-repo max is configured in .har/stages.json and harness.env. */
export const HAR_AGENT_SLOT_MIN = 1;

/** Lightweight manifest — metadata only, not runtime behavior. */
export const HarnessManifestSchema = z.object({
  version: z.string(),
  generatorVersion: z.string(),
  outputDir: z.string().default('.har'),
  createdAt: z.string(),
  updatedAt: z.string(),
  stack: z
    .object({
      language: z.string().optional(),
      packageManager: z.string().optional(),
      database: z.string().optional(),
    })
    .optional(),
  adaptationSummary: z.string().optional(),
  profile: z.enum(['default', 'cli', 'ios']).optional(),
  fileChecksums: z.record(z.string()).optional(),
});

export type HarnessManifest = z.infer<typeof HarnessManifestSchema>;

export const HarnessStageKindSchema = z.enum(HAR_STAGE_KINDS);

export type HarnessStageKind = z.infer<typeof HarnessStageKindSchema>;

export const HarnessArtifactKindSchema = z.enum([
  'file',
  'directory',
  'log',
  'report',
  'screenshot',
  'trace',
  'video',
  'url',
]);

export const HarnessArtifactSchema = z
  .object({
    id: z.string().optional(),
    path: z.string().min(1),
    kind: HarnessArtifactKindSchema.default('file'),
    description: z.string().optional(),
  })
  .passthrough();

export type HarnessArtifact = z.infer<typeof HarnessArtifactSchema>;

const HarnessStageIdSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'stage id must be stable and shell-friendly');

export const HarnessStageSchema = z
  .object({
    id: HarnessStageIdSchema,
    kind: HarnessStageKindSchema,
    description: z.string().optional(),
    script: z.string().min(1).optional(),
    command: z.string().min(1).optional(),
    cwd: z.string().optional(),
    env: z.record(z.string()).optional(),
    resultPath: z.string().optional(),
    artifacts: z.array(HarnessArtifactSchema).default([]),
    requiresAgentId: z.boolean().optional(),
    group: z.string().optional(),
    acceptsArgs: z.array(z.string()).optional(),
  })
  .passthrough();

export type HarnessStage = z.infer<typeof HarnessStageSchema>;

export const HarnessAgentSlotsSchema = z
  .object({
    min: z.number().int().min(HAR_AGENT_SLOT_MIN).default(HAR_AGENT_SLOT_MIN),
    max: z.number().int().min(HAR_AGENT_SLOT_MIN),
  })
  .refine((slots) => slots.max >= slots.min, {
    message: 'agentSlots.max must be >= agentSlots.min',
  });

/** Commit-gate configuration: whether unverified change batches may be committed. */
export const CommitGateConfigSchema = z.object({
  enabled: z.boolean().default(true),
  mode: z.enum(['block', 'warn']).default('block'),
  /** 'worktrees' enforces mode only in har agent worktrees and warns elsewhere. */
  scope: z.enum(['worktrees', 'all']).default('worktrees'),
  /** Future: stages required to validate a batch. Ignored in v1 (full verify required). */
  requiredStages: z.array(z.string()).optional(),
});

export type CommitGateConfig = z.infer<typeof CommitGateConfigSchema>;

export const HarnessStageRegistrySchema = z
  .object({
    version: z.string().default('1'),
    artifactsDir: z.string().default('artifacts'),
    logsDir: z.string().default('logs'),
    agentSlots: HarnessAgentSlotsSchema.optional(),
    verificationStages: z.array(z.string()).optional(),
    stages: z.array(HarnessStageSchema).default([]),
    commitGate: CommitGateConfigSchema.optional(),
  })
  .passthrough();

export type HarnessStageRegistry = z.infer<typeof HarnessStageRegistrySchema>;

export const HarnessVerificationStepSchema = z.object({
  name: z.string(),
  pass: z.boolean(),
  ms: z.number().optional(),
  output: z.string().optional(),
});

export type HarnessVerificationStep = z.infer<typeof HarnessVerificationStepSchema>;

export const ShellRunOutputSchema = z.object({
  code: z.number(),
  stdout: z.string(),
  stderr: z.string(),
});

export type ShellRunOutput = z.infer<typeof ShellRunOutputSchema>;

export const HarnessVerificationResultSchema = z.object({
  status: z.enum(['pass', 'fail']),
  agent_id: z.number().int().min(HAR_AGENT_SLOT_MIN),
  total_ms: z.number().optional(),
  stages: z.array(HarnessVerificationStepSchema),
});

export type HarnessVerificationResult = z.infer<typeof HarnessVerificationResultSchema>;

export const HarnessStageRunStatusSchema = z.enum([
  'pass',
  'fail',
  'error',
  'skipped',
  'unknown',
]);

export type HarnessStageRunStatus = z.infer<typeof HarnessStageRunStatusSchema>;

export const HarnessStageLogSchema = z
  .object({
    stream: z.enum(['stdout', 'stderr', 'combined']).optional(),
    path: z.string().optional(),
    content: z.string().optional(),
  })
  .passthrough();

export const HarnessStageUrlSchema = z
  .object({
    label: z.string().optional(),
    url: z.string().url(),
  })
  .passthrough();

export const HarnessStageRunResultSchema = z
  .object({
    status: HarnessStageRunStatusSchema,
    stageId: z.string().optional(),
    kind: HarnessStageKindSchema.optional(),
    command: z.string().optional(),
    code: z.number().int().optional(),
    durationMs: z.number().nonnegative().optional(),
    startedAt: z.string().optional(),
    finishedAt: z.string().optional(),
    logs: z.array(HarnessStageLogSchema).default([]),
    artifacts: z.array(HarnessArtifactSchema).default([]),
    urls: z.array(HarnessStageUrlSchema).default([]),
    error: z.string().optional(),
    data: z.unknown().optional(),
  })
  .passthrough();

export type HarnessStageRunResult = z.infer<typeof HarnessStageRunResultSchema>;

export const StageKindSchema = HarnessStageKindSchema;
export type StageKind = HarnessStageKind;
export const StageRegistrySchema = HarnessStageRegistrySchema;
export type StageRegistry = HarnessStageRegistry;
export const StageStepResultSchema = HarnessVerificationStepSchema;
export type StageStepResult = HarnessVerificationStep;
export const VerificationResultSchema = HarnessVerificationResultSchema;
export type VerificationResult = HarnessVerificationResult;
export const StageResultSchema = HarnessStageRunResultSchema;
export type StageResult = HarnessStageRunResult;

export const RunRecordTriggerSchema = z.enum(['cli', 'mcp', 'script']);

export const RunRecordSchema = z
  .object({
    runId: z.string().uuid(),
    repoPath: z.string(),
    stageId: z.string(),
    kind: HarnessStageKindSchema.optional(),
    agentId: z.number().int().optional(),
    status: HarnessStageRunStatusSchema,
    startedAt: z.string(),
    finishedAt: z.string().optional(),
    durationMs: z.number().nonnegative().optional(),
    result: HarnessStageRunResultSchema.optional(),
    trigger: RunRecordTriggerSchema.default('cli'),
    relativePath: z.string().optional(),
    command: z.string().optional(),
    workDir: z.string().optional(),
    harnessRoot: z.string().optional(),
  })
  .passthrough();

export type RunRecord = z.infer<typeof RunRecordSchema>;

/**
 * One slot session, persisted at .har/slots/agent-<id>.json by launch.sh.
 * Source of truth for where a slot's code lives — worktree paths carry a
 * random per-session suffix and cannot be derived from the agent id alone.
 */
export const SlotRegistryEntrySchema = z
  .object({
    version: z.number().int().default(1),
    agentId: z.number().int().min(HAR_AGENT_SLOT_MIN),
    projectName: z.string(),
    mode: z.enum(['worktree', 'root']),
    /** Where edits/builds happen: worktree + monorepo prefix, or the repo root. */
    workDir: z.string(),
    /** Git checkout root of the session worktree (absent in root mode). */
    worktreePath: z.string().optional(),
    /** Session branch: <base-branch>-<sha4>-har-agent-<id>-<rand4>. */
    branch: z.string().optional(),
    /** Branch the session was launched from (e.g. main). */
    baseBranch: z.string().optional(),
    /** HEAD sha at launch time. */
    baseCommit: z.string().optional(),
    /** Random per-session chars; absent in root mode. */
    suffix: z.string().optional(),
    createdAt: z.string(),
    purpose: z.string().optional(),
    ports: z.record(z.number()).optional(),
    previewUrls: z.record(z.string()).optional(),
    status: z.enum(['active', 'completed']).default('active'),
  })
  .passthrough();

export type SlotRegistryEntry = z.infer<typeof SlotRegistryEntrySchema>;

/** Structured slot status for Mission Control and `har env status --json`. */
export const AgentSlotHarnessUsageSchema = z.enum([
  'mcp',
  'cli',
  'script',
  'none',
  'bypass_warning',
]);

export type AgentSlotHarnessUsage = z.infer<typeof AgentSlotHarnessUsageSchema>;

export const AgentSlotStatusSchema = z.object({
  agentId: z.number().int().min(HAR_AGENT_SLOT_MIN),
  active: z.boolean(),
  workDir: z.string().optional(),
  worktreePath: z.string().optional(),
  branch: z.string().optional(),
  previewUrls: z.record(z.string()).optional(),
  harnessUsage: AgentSlotHarnessUsageSchema,
  lastRunId: z.string().uuid().optional(),
  lastRunAt: z.string().optional(),
  lastVerifyStatus: HarnessStageRunStatusSchema.optional(),
  lastBuildPass: z.boolean().optional(),
  mode: z.enum(['worktree', 'root']).optional(),
  suffix: z.string().optional(),
  baseBranch: z.string().optional(),
  baseCommit: z.string().optional(),
  sessionCreatedAt: z.string().optional(),
  purpose: z.string().optional(),
  /** Worktree checked out to no branch (legacy failure mode; should not happen with sessions). */
  detachedHead: z.boolean().optional(),
  /** Worktree has uncommitted changes. */
  dirty: z.boolean().optional(),
  /** Session commits on top of baseCommit. */
  ahead: z.number().int().optional(),
  /** Main checkout has commits the session base doesn't (worktree serves stale code). */
  behind: z.number().int().optional(),
  stale: z.boolean().optional(),
});

export type AgentSlotStatus = z.infer<typeof AgentSlotStatusSchema>;

export const EnvironmentStatusSchema = z.object({
  repoPath: z.string(),
  harnessRoot: z.string(),
  gitRemote: z.string().optional(),
  profile: z.enum(['default', 'cli', 'ios']).optional(),
  slots: z.array(AgentSlotStatusSchema),
  generatedAt: z.string(),
});

export type EnvironmentStatus = z.infer<typeof EnvironmentStatusSchema>;

export const RegisterRepoInputSchema = z.object({
  path: z.string().min(1),
  gitRemote: z.string().optional(),
  manifest: HarnessManifestSchema.optional(),
  stagesRegistry: HarnessStageRegistrySchema.optional(),
});

export type RegisterRepoInput = z.infer<typeof RegisterRepoInputSchema>;

export const SyncRunsInputSchema = z.object({
  runs: z.array(RunRecordSchema),
});

export type SyncRunsInput = z.infer<typeof SyncRunsInputSchema>;

export const SyncSlotsInputSchema = z.object({
  slots: z.array(AgentSlotStatusSchema),
  generatedAt: z.string(),
});

export type SyncSlotsInput = z.infer<typeof SyncSlotsInputSchema>;

/** Git name-status letters (rename/copy carry oldPath). */
export const ChangedFileStatusSchema = z.enum(['A', 'M', 'D', 'R', 'C', 'T', 'U']);

export type ChangedFileStatus = z.infer<typeof ChangedFileStatusSchema>;

export const ChangedFileSchema = z.object({
  path: z.string(),
  status: ChangedFileStatusSchema,
  oldPath: z.string().optional(),
});

export type ChangedFile = z.infer<typeof ChangedFileSchema>;

/**
 * One validation per change batch, keyed by the git tree hash of the exact
 * code state a verification ran against.
 */
export const ValidationRecordSchema = z
  .object({
    validationId: z.string().uuid(),
    treeHash: z.string().regex(/^[0-9a-f]{40,64}$/),
    headSha: z.string().optional(),
    branch: z.string().optional(),
    workDir: z.string(),
    harnessRoot: z.string(),
    agentId: z.number().int().optional(),
    status: z.enum(['pass', 'fail']),
    full: z.boolean().default(false),
    runId: z.string().uuid().optional(),
    changedFiles: z.array(ChangedFileSchema).default([]),
    createdAt: z.string(),
    updatedAt: z.string(),
    commitSha: z.string().optional(),
    committedAt: z.string().optional(),
  })
  .passthrough();

export type ValidationRecord = z.infer<typeof ValidationRecordSchema>;

export const SyncValidationsInputSchema = z.object({
  validations: z.array(ValidationRecordSchema),
});

export type SyncValidationsInput = z.infer<typeof SyncValidationsInputSchema>;
