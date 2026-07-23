import { z } from 'zod';
import {
  HAR_AGENT_SLOT_MIN,
  HarnessManifestSchema,
  HarnessStageSchema,
  RunRecordSchema,
  ShellRunOutputSchema,
  SlotReadinessSchema,
  StageKindSchema,
  StageResultSchema,
  VerificationResultSchema,
} from '../harness/schema';

export const RepoPathInputSchema = z.object({
  repo: z.string().default('.').describe('Path to the repository'),
});

const agentIdSchema = z.number().int().min(HAR_AGENT_SLOT_MIN);

export const AgentIdInputSchema = z.object({
  repo: z.string().default('.'),
  agentId: agentIdSchema,
});

export const DescribeProjectOutputSchema = z.object({
  repoPath: z.string(),
  harnessPresent: z.boolean(),
  manifest: HarnessManifestSchema.nullable(),
  scripts: z.array(z.string()),
  stages: z.array(HarnessStageSchema),
  verificationStages: z.array(z.string()),
  agentSlots: z
    .object({
      min: z.number().int(),
      max: z.number().int(),
    })
    .nullable(),
  stackHints: z.object({
    language: z.string().optional(),
    packageManager: z.string().optional(),
    database: z.string().optional(),
  }),
  harnessDrift: z
    .object({
      generatorVersion: z.object({
        installed: z.string().optional(),
        bundled: z.string(),
        outdated: z.boolean(),
      }),
      missing: z.array(z.string()),
      checksumMismatch: z.array(z.string()),
      extra: z.array(z.string()),
      unchanged: z.array(z.string()),
    })
    .nullable(),
});

export const InitHarnessInputSchema = z.object({
  repo: z.string().default('.'),
  force: z.boolean().default(false),
  auto: z.boolean().default(false),
  smoke: z.boolean().default(false),
  profile: z.enum(['default', 'cli', 'ios']).default('default'),
});

export const LaunchEnvironmentInputSchema = z.object({
  repo: z.string().default('.'),
  agentId: agentIdSchema,
  worktree: z.boolean().default(true),
  claude: z.boolean().default(false),
  confirmReplace: z
    .boolean()
    .default(false)
    .describe(
      'Replace an occupied slot. Required when a session is already active. Call har_get_status first; get explicit user approval before setting this.',
    ),
  force: z
    .boolean()
    .default(false)
    .describe(
      'Discard uncommitted changes in a dirty occupied worktree. Requires confirmReplace=true and explicit user approval — never set autonomously.',
    ),
  resume: z
    .boolean()
    .default(false)
    .describe('Resume a failed or partial launch without creating a new worktree.'),
  workUnitId: z.string().min(1).max(128).optional(),
  source: z.string().min(1).max(64).optional(),
  sourceUrl: z.string().url().optional(),
  title: z.string().min(1).max(256).optional(),
  parentWorkUnitId: z.string().min(1).max(128).optional(),
});

export const LaunchEnvironmentOutputSchema = ShellRunOutputSchema.extend({
  previewUrls: z.record(z.string()).optional(),
  workDir: z
    .string()
    .optional()
    .describe('Where the session code lives — ALL file edits must go under this path'),
  worktreePath: z.string().optional(),
  branch: z.string().optional(),
  workUnitId: z.string().optional(),
  attemptId: z.string().uuid().optional(),
  blocked: z.boolean().optional(),
  occupiedSlot: z
    .object({
      agentId: z.number().int(),
      workDir: z.string().optional(),
      worktreePath: z.string().optional(),
      branch: z.string().optional(),
      dirty: z.boolean().optional(),
      sessionCreatedAt: z.string().optional(),
    })
    .optional(),
});

export const PreflightEnvironmentInputSchema = z.object({
  repo: z.string().default('.'),
  agentId: agentIdSchema,
  confirmReplace: z
    .boolean()
    .default(false)
    .describe('Treat an occupied slot as replaceable (same as launch confirmReplace).'),
  force: z
    .boolean()
    .default(false)
    .describe('Allow replacing a dirty worktree (requires explicit user approval).'),
});

export const PreflightEnvironmentOutputSchema = ShellRunOutputSchema.extend({
  readiness: SlotReadinessSchema,
  blocked: z.boolean().optional(),
});

export const CompleteEnvironmentInputSchema = z.object({
  repo: z.string().default('.'),
  agentId: agentIdSchema,
  skipVerify: z
    .boolean()
    .default(false)
    .describe('Tear down without running verification (no validation is recorded)'),
});

export const CompleteEnvironmentOutputSchema = ShellRunOutputSchema.extend({
  branch: z.string().optional().describe('Session branch kept for the user to push / open a PR'),
  verification: VerificationResultSchema.nullable().optional(),
});

export const TeardownEnvironmentInputSchema = z.object({
  repo: z.string().default('.'),
  agentId: agentIdSchema,
  deleteBranch: z.boolean().default(false).describe('Also delete the session git branch'),
});

export const RunStageInputSchema = z.object({
  repo: z.string().default('.'),
  stageId: z.string().optional(),
  kind: StageKindSchema.optional(),
  agentId: agentIdSchema.optional(),
  args: z.array(z.string()).optional(),
});

export const RunVerificationInputSchema = z.object({
  repo: z.string().default('.'),
  agentId: agentIdSchema,
  full: z.boolean().default(false),
});

export const RunVerificationOutputSchema = ShellRunOutputSchema.extend({
  verification: VerificationResultSchema.nullable(),
});

export const GetLogsInputSchema = z.object({
  repo: z.string().default('.'),
  agentId: agentIdSchema,
  service: z.string().optional(),
});

export const ListArtifactsInputSchema = z.object({
  repo: z.string().default('.'),
  stageId: z.string().optional(),
});

export const ArtifactEntrySchema = z.object({
  path: z.string(),
  relativePath: z.string(),
  sizeBytes: z.number(),
  modifiedAt: z.string(),
});

export const ListArtifactsOutputSchema = z.object({
  artifacts: z.array(ArtifactEntrySchema),
});

export const EnvironmentRunOutputSchema = ShellRunOutputSchema;

export const ListRunsInputSchema = z.object({
  repo: z.string().default('.'),
  stageId: z.string().optional(),
  limit: z.number().int().positive().default(50),
});

export const ListRunsOutputSchema = z.object({
  runs: z.array(RunRecordSchema),
});

export const GetRunInputSchema = z.object({
  repo: z.string().default('.'),
  runId: z.string().uuid(),
});

export const GetRunOutputSchema = z.object({
  run: RunRecordSchema,
});

export const ControlUpInputSchema = z.object({
  repo: z.string().default('.').describe('Working directory for repo discovery during sync'),
  detach: z.boolean().default(true).describe('Run Docker Compose in detached mode'),
});

export const ControlUpOutputSchema = z.object({
  apiUrl: z.string(),
  synced: z.number().int(),
  failed: z.number().int(),
  apiReady: z.boolean(),
});

export { StageResultSchema };
