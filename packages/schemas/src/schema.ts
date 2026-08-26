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

/** Agent targets for scaffolded skills/commands (Claude Code, Cursor, Codex CLI). */
export const AgentSkillTargetSchema = z.enum(['claude', 'cursor', 'codex']);

export type AgentSkillTarget = z.infer<typeof AgentSkillTargetSchema>;

/** A skill/command file scaffolded outside .har/ (or globally for Codex), tracked for maintain. */
export const ScaffoldedAgentFileSchema = z.object({
  /** Repo-relative path, or '~/…' when scope is 'global'. */
  path: z.string(),
  agent: AgentSkillTargetSchema,
  skill: z.string(),
  checksum: z.string(),
  scope: z.enum(['repo', 'global']).default('repo'),
});

export type ScaffoldedAgentFile = z.infer<typeof ScaffoldedAgentFileSchema>;

/** Lightweight manifest — metadata only, not runtime behavior. */
export const HarnessManifestSchema = z.object({
  version: z.string(),
  /** Legacy field — ignored. Drift is file checksums vs bundled templates. */
  generatorVersion: z.string().optional(),
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
  scaffoldedAgentFiles: z.array(ScaffoldedAgentFileSchema).optional(),
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

/** User-level defaults applied when init/maintain flags are omitted. */
export const OnboardingPreferencesSchema = z.object({
  version: z.literal(1).default(1),
  cursorRule: z.enum(['auto', 'on', 'off']).default('auto'),
  agentSkills: z.union([z.literal('auto'), z.array(AgentSkillTargetSchema)]).default('auto'),
  commitGate: z
    .object({
      install: z.enum(['prompt', 'always', 'never']).default('prompt'),
      mode: z.enum(['block', 'warn']).default('block'),
      scope: z.enum(['worktrees', 'all']).default('worktrees'),
    })
    .default({}),
  updatedAt: z.string().optional(),
});

export type OnboardingPreferences = z.infer<typeof OnboardingPreferencesSchema>;

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
  coverage: z.number().min(0).max(100).optional(),
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

export const WorkUnitIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:/#@-]*$/,
    'work unit id must start with an alphanumeric character and contain only stable identifier characters',
  );

export const WorkAttemptIdSchema = z.string().uuid();

/** Secondary external link (PR, mirrored issue, alternate tracker). Append-only on the work unit. */
export const WorkUnitRelatedLinkSchema = z.object({
  source: z.string().min(1).max(64),
  url: z.string().url(),
  label: z.string().min(1).max(128).optional(),
});

export type WorkUnitRelatedLink = z.infer<typeof WorkUnitRelatedLinkSchema>;

export const WorkUnitMetadataSchema = z.object({
  workUnitId: WorkUnitIdSchema,
  source: z.string().min(1).max(64).optional(),
  sourceUrl: z.string().url().optional(),
  title: z.string().min(1).max(256).optional(),
  parentWorkUnitId: WorkUnitIdSchema.optional(),
  relatedLinks: z.array(WorkUnitRelatedLinkSchema).optional(),
});

export type WorkUnitMetadata = z.infer<typeof WorkUnitMetadataSchema>;

export const WorkUnitOutcomeSchema = z
  .object({
    decision: z.enum(['completed', 'abandoned']),
    decidedAt: z.string(),
    attemptId: WorkAttemptIdSchema.optional(),
    validationId: z.string().uuid().optional(),
    treeHash: z.string().regex(/^[0-9a-f]{40,64}$/).optional(),
    reason: z.string().max(2000).optional(),
  })
  .superRefine((outcome, ctx) => {
    if (
      outcome.decision === 'completed' &&
      (!outcome.attemptId || !outcome.validationId || !outcome.treeHash)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'completed work must reference an attempt and exact-tree validation',
      });
    }
  });

export type WorkUnitOutcome = z.infer<typeof WorkUnitOutcomeSchema>;

/** Durable intent and explicit business outcome. Execution state is derived from evidence. */
export const WorkUnitRecordSchema = WorkUnitMetadataSchema.extend({
  version: z.number().int().default(1),
  createdAt: z.string(),
  updatedAt: z.string(),
  outcome: WorkUnitOutcomeSchema.optional(),
}).passthrough();

export type WorkUnitRecord = z.infer<typeof WorkUnitRecordSchema>;

/** Immutable identity for one launch/session attempt of a work unit. */
export const WorkAttemptRecordSchema = z
  .object({
    version: z.number().int().default(1),
    attemptId: WorkAttemptIdSchema,
    workUnitId: WorkUnitIdSchema,
    agentId: z.number().int().min(HAR_AGENT_SLOT_MIN),
    sessionKey: z.string().min(1).optional(),
    workDir: z.string().optional(),
    worktreePath: z.string().optional(),
    branch: z.string().optional(),
    baseCommit: z.string().optional(),
    createdAt: z.string(),
  })
  .passthrough();

export type WorkAttemptRecord = z.infer<typeof WorkAttemptRecordSchema>;

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
    workUnitId: WorkUnitIdSchema.optional(),
    attemptId: WorkAttemptIdSchema.optional(),
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
    ports: z.record(z.number()).optional(),
    previewUrls: z.record(z.string()).optional(),
    workUnitId: WorkUnitIdSchema.optional(),
    attemptId: WorkAttemptIdSchema.optional(),
    status: z.enum(['starting', 'active', 'failed', 'completed']).default('active'),
    lastError: z.string().optional(),
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

/** One actionable launch blocker from preflight / readiness inspection. */
export const PreflightBlockerSchema = z.object({
  code: z.string(),
  message: z.string(),
  remediation: z.string().optional(),
  details: z.record(z.unknown()).optional(),
});

export type PreflightBlocker = z.infer<typeof PreflightBlockerSchema>;

/** Readiness verdict for a slot — observability in status, hard gate before launch. */
export const SlotReadinessSchema = z.object({
  canLaunch: z.boolean(),
  verdict: z.enum(['ready', 'blocked']),
  blockers: z.array(PreflightBlockerSchema),
  remediations: z.array(z.string()),
  ports: z.record(z.number()).optional(),
  allocatedPorts: z.boolean().optional(),
  /** A warning already states why this port was chosen — suppresses the generic note. */
  portChoiceExplained: z.boolean().optional(),
  /** Non-blocking notices (e.g. har control up holds the default port but an alternate was picked). */
  warnings: z.array(z.string()).optional(),
});

export type SlotReadiness = z.infer<typeof SlotReadinessSchema>;

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
  /** Derived from first captured user prompt (OTEL hooks); not set at launch. */
  purpose: z.string().optional(),
  workUnitId: WorkUnitIdSchema.optional(),
  attemptId: WorkAttemptIdSchema.optional(),
  sessionStatus: z.enum(['starting', 'active', 'failed', 'completed']).optional(),
  lastError: z.string().optional(),
  /** Set when a failed/starting session can be resumed with --resume instead of a fresh launch. */
  resumeHint: z.string().optional(),
  /** Worktree checked out to no branch (legacy failure mode; should not happen with sessions). */
  detachedHead: z.boolean().optional(),
  /** Worktree has uncommitted changes. */
  dirty: z.boolean().optional(),
  /** Session commits on top of baseCommit. */
  ahead: z.number().int().optional(),
  /** Main checkout has commits the session base doesn't (worktree serves stale code). */
  behind: z.number().int().optional(),
  stale: z.boolean().optional(),
  /** Persisted host ports from the slot registry (when dynamically allocated). */
  ports: z.record(z.number()).optional(),
  /** PM2 namespace mismatch — foreign or legacy processes for this slot id. */
  pm2Issue: z.enum(['foreign_pm2', 'registry_missing', 'project_mismatch']).optional(),
  /** Launch readiness slice — same core as `har env preflight`. */
  readiness: SlotReadinessSchema.optional(),
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
  /** Clear a prior unregister blocklist entry and re-register. */
  force: z.boolean().optional(),
});

export type RegisterRepoInput = z.infer<typeof RegisterRepoInputSchema>;

export const UnregisterRepoInputSchema = z.object({
  /** When true, attempt to remove session worktrees on disk (host paths). */
  deleteWorktrees: z.boolean().optional().default(false),
});

export type UnregisterRepoInput = z.infer<typeof UnregisterRepoInputSchema>;

export const UnregisterWorktreeResultSchema = z.object({
  path: z.string(),
  agentId: z.number().optional(),
  deleted: z.boolean(),
  error: z.string().optional(),
});

export type UnregisterWorktreeResult = z.infer<typeof UnregisterWorktreeResultSchema>;

export const UnregisterRepoResultSchema = z.object({
  ok: z.literal(true),
  id: z.string(),
  path: z.string(),
  deleteWorktrees: z.boolean(),
  worktrees: z.array(UnregisterWorktreeResultSchema),
});

export type UnregisterRepoResult = z.infer<typeof UnregisterRepoResultSchema>;

/** Wipe all Mission Control data. Requires confirm === "RESET". */
export const ResetMissionControlInputSchema = z.object({
  confirm: z.literal('RESET'),
  /**
   * When true, delete `.har/{runs,validations,state,slots}` under each registered
   * repository path (best-effort; Docker often cannot see host paths).
   */
  scrubLocalHarness: z.boolean().optional().default(true),
});

export type ResetMissionControlInput = z.infer<typeof ResetMissionControlInputSchema>;

export const HarnessScrubResultSchema = z.object({
  path: z.string(),
  directory: z.string(),
  deleted: z.boolean(),
  error: z.string().optional(),
});

export type HarnessScrubResult = z.infer<typeof HarnessScrubResultSchema>;

export const ResetMissionControlResultSchema = z.object({
  ok: z.literal(true),
  repositoriesDeleted: z.number().int().nonnegative(),
  unregisteredCleared: z.number().int().nonnegative(),
  scrubLocalHarness: z.boolean(),
  scrubbed: z.array(HarnessScrubResultSchema),
  repoPaths: z.array(z.string()),
});

export type ResetMissionControlResult = z.infer<typeof ResetMissionControlResultSchema>;

/** Bulk-delete session worktrees recorded in Mission Control. */
export const DeleteWorktreesInputSchema = z.object({
  worktrees: z
    .array(
      z.object({
        repoId: z.string().min(1),
        slotId: z.number().int().positive(),
      }),
    )
    .min(1),
  /**
   * When true (default), also drop Mission Control slot rows when the path is
   * already missing on disk (stale dashboard entries).
   */
  clearMissing: z.boolean().optional().default(true),
});

export type DeleteWorktreesInput = z.infer<typeof DeleteWorktreesInputSchema>;

export const DeleteWorktreeResultSchema = z.object({
  repoId: z.string(),
  slotId: z.number(),
  path: z.string(),
  deleted: z.boolean(),
  clearedFromDashboard: z.boolean(),
  error: z.string().optional(),
});

export type DeleteWorktreeResult = z.infer<typeof DeleteWorktreeResultSchema>;

export const DeleteWorktreesResultSchema = z.object({
  ok: z.literal(true),
  results: z.array(DeleteWorktreeResultSchema),
});

export type DeleteWorktreesResult = z.infer<typeof DeleteWorktreesResultSchema>;

export const SyncRunsInputSchema = z.object({
  runs: z.array(RunRecordSchema),
});

export type SyncRunsInput = z.infer<typeof SyncRunsInputSchema>;

export const SyncSlotsInputSchema = z.object({
  slots: z.array(AgentSlotStatusSchema),
  generatedAt: z.string(),
});

export type SyncSlotsInput = z.infer<typeof SyncSlotsInputSchema>;

export const SyncWorkUnitsInputSchema = z.object({
  workUnits: z.array(WorkUnitRecordSchema),
  attempts: z.array(WorkAttemptRecordSchema),
});

export type SyncWorkUnitsInput = z.infer<typeof SyncWorkUnitsInputSchema>;

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

/** Many-to-many proof link: one exact-tree validation may prove multiple work attempts. */
export const ValidationBindingRecordSchema = z.object({
  bindingId: z.string().uuid(),
  workUnitId: WorkUnitIdSchema,
  attemptId: WorkAttemptIdSchema,
  validationId: z.string().uuid(),
  treeHash: z.string().regex(/^[0-9a-f]{40,64}$/),
  createdAt: z.string(),
});

export type ValidationBindingRecord = z.infer<typeof ValidationBindingRecordSchema>;

export const SyncValidationBindingsInputSchema = z.object({
  bindings: z.array(ValidationBindingRecordSchema),
});

export type SyncValidationBindingsInput = z.infer<typeof SyncValidationBindingsInputSchema>;

export const AgentToolSchema = z.enum(['claude_code', 'codex', 'cursor']);
export type AgentTool = z.infer<typeof AgentToolSchema>;

export const UsageSourceSchema = z.enum(['otel', 'harvest']);
export type UsageSource = z.infer<typeof UsageSourceSchema>;

/** Durable origin of an immutable agent trajectory fact. */
export const AgentTrajectorySourceSchema = z.enum(['otel', 'harvest', 'har']);
export type AgentTrajectorySource = z.infer<typeof AgentTrajectorySourceSchema>;

/** How much of the original content is present in payload. */
export const AgentTrajectoryContentDisclosureSchema = z.enum([
  'full',
  'redacted',
  'masked',
  'truncated',
  'withheld',
  'metadata_only',
]);
export type AgentTrajectoryContentDisclosure = z.infer<
  typeof AgentTrajectoryContentDisclosureSchema
>;

/**
 * Version 1 of the canonical, append-only agent trajectory fact.
 *
 * `sourceEventId` identifies the producer event while `contentKey` identifies
 * one content fact within it. Multiple facts may therefore share an event id
 * and sequence without overwriting each other.
 *
 * Ordering is deterministic: `sequence`, then occurrence `timestamp`, then
 * `source`, `sourceEventId`, `contentKey`, and the storage row id. Duplicate
 * OTLP/harvest delivery is idempotent on `(source, sourceEventId, contentKey)`.
 * Late or out-of-order facts keep their producer sequence; clients merge by
 * that order rather than ingestion time. Partial content is represented by
 * `contentDisclosure` (`truncated` / `redacted` / `withheld` / `metadata_only`)
 * instead of guessed bodies.
 */
export const AgentTrajectoryRecordV1Schema = z
  .object({
    version: z.literal(1),
    source: AgentTrajectorySourceSchema,
    sourceEventId: z.string().min(1),
    contentKey: z.string().min(1),
    sessionKey: z.string().min(1),
    agentId: z.number().int().min(HAR_AGENT_SLOT_MIN),
    agentTool: AgentToolSchema,
    eventType: z.string().min(1),
    sequence: z.number().int().nonnegative(),
    timestamp: z.string(),
    payload: z.record(z.unknown()),
    contentKind: z.string().min(1),
    contentDisclosure: AgentTrajectoryContentDisclosureSchema,
    contentLabel: z.string().optional(),
    traceId: z.string().optional(),
    spanId: z.string().optional(),
    parentSpanId: z.string().optional(),
    generationId: z.string().optional(),
    toolCallId: z.string().optional(),
    correlationId: z.string().optional(),
    workUnitId: WorkUnitIdSchema.optional(),
    attemptId: WorkAttemptIdSchema.optional(),
  })
  .passthrough();

export const AgentTrajectoryRecordSchema = AgentTrajectoryRecordV1Schema;
export type AgentTrajectoryRecordV1 = z.infer<typeof AgentTrajectoryRecordV1Schema>;
export type AgentTrajectoryRecord = AgentTrajectoryRecordV1;

/** Generation of the usage-harvest algorithm; a newer one supersedes an older. */
export const USAGE_HARVEST_VERSION = 1;

/** Harvested before the algorithm was versioned, so the totals read high. */
export const PRE_DEDUPE_HARVEST_VERSION = 0;

/** Per-session agent token/cost aggregates for Mission Control. */
export const AgentSessionUsageSchema = z.object({
  sessionKey: z.string().min(1),
  agentId: z.number().int().min(HAR_AGENT_SLOT_MIN),
  agentTool: AgentToolSchema,
  userEmail: z.string().email().optional(),
  workDir: z.string().optional(),
  branch: z.string().optional(),
  suffix: z.string().optional(),
  workUnitId: WorkUnitIdSchema.optional(),
  attemptId: WorkAttemptIdSchema.optional(),
  tokensInput: z.number().nonnegative().default(0),
  tokensOutput: z.number().nonnegative().default(0),
  tokensCacheRead: z.number().nonnegative().default(0),
  tokensCacheCreation: z.number().nonnegative().default(0),
  tokensTotal: z.number().nonnegative().default(0),
  costUsd: z.number().nonnegative().nullable().optional(),
  modelBreakdown: z.record(z.unknown()).optional(),
  sources: z.array(UsageSourceSchema).default([]),
  harvestVersion: z.number().int().nonnegative().default(PRE_DEDUPE_HARVEST_VERSION),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
});

export type AgentSessionUsage = z.infer<typeof AgentSessionUsageSchema>;

export const SyncUsageInputSchema = z.object({
  usage: z.array(AgentSessionUsageSchema),
});

export type SyncUsageInput = z.infer<typeof SyncUsageInputSchema>;

/** Per-session agent log/event rows for Mission Control timelines. */
export const AgentSessionEventSchema = z.object({
  sessionKey: z.string().min(1),
  agentId: z.number().int().min(HAR_AGENT_SLOT_MIN),
  agentTool: AgentToolSchema,
  eventName: z.string().min(1),
  sequence: z.number().int().nonnegative().default(0),
  timestamp: z.string(),
  workUnitId: WorkUnitIdSchema.optional(),
  attemptId: WorkAttemptIdSchema.optional(),
  attributes: z.record(z.unknown()).optional(),
  promptText: z.string().nullable().optional(),
  responseText: z.string().nullable().optional(),
  rawTruncated: z.string().nullable().optional(),
  source: z.enum(['otel', 'harvest']).default('otel'),
});

export type AgentSessionEvent = z.infer<typeof AgentSessionEventSchema>;

export const SyncSessionEventsInputSchema = z.object({
  events: z.array(AgentSessionEventSchema),
});

export type SyncSessionEventsInput = z.infer<typeof SyncSessionEventsInputSchema>;
