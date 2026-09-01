import { z } from 'zod';
import {
  EnvironmentStatusSchema,
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
      missing: z.array(z.string()),
      userAdapted: z.array(z.string()),
      upstreamUpdated: z.array(z.string()),
      conflict: z.array(z.string()),
      extra: z.array(z.string()),
      unchanged: z.array(z.string()),
      /** User-owned files on an ejected harness (#239) — present, never drift. */
      ownedByUser: z.array(z.string()).optional(),
    })
    .nullable(),
});

export const InitHarnessInputSchema = z.object({
  repo: z.string().default('.'),
  force: z.boolean().default(false),
  smoke: z.boolean().default(false),
  profile: z.enum(['default', 'cli', 'ios']).default('default'),
});

export const LaunchEnvironmentInputSchema = z.object({
  repo: z.string().default('.'),
  agentId: agentIdSchema,
  worktree: z.boolean().default(true),
  claude: z.boolean().default(false),
  resume: z
    .boolean()
    .default(false)
    .describe(
      'Resume a failed or partial launch without creating a new worktree. Only valid for failed/starting sessions — otherwise call har_get_status, then har_complete_environment or har_teardown_environment before launching again.',
    ),
  workUnitId: z.string().min(1).max(128).optional(),
  source: z.string().min(1).max(64).optional(),
  sourceUrl: z.string().url().optional(),
  title: z.string().min(1).max(256).optional(),
  parentWorkUnitId: z.string().min(1).max(128).optional(),
  relatedLinks: z
    .array(
      z.object({
        source: z.string().min(1).max(64),
        url: z.string().url(),
        label: z.string().min(1).max(128).optional(),
      }),
    )
    .optional(),
});

export const AddWorkUnitLinkInputSchema = z.object({
  repo: z.string().default('.'),
  workUnitId: z.string().min(1).max(128),
  source: z.string().min(1).max(64),
  url: z.string().url(),
  label: z.string().min(1).max(128).optional(),
});

export const LaunchEnvironmentOutputSchema = ShellRunOutputSchema.extend({
  warnings: z
    .array(z.string())
    .optional()
    .describe('Advisory readiness warnings — never block the launch'),
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
});

export const PreflightEnvironmentOutputSchema = ShellRunOutputSchema.extend({
  readiness: SlotReadinessSchema,
  blocked: z.boolean().optional(),
});

export const CompleteEnvironmentInputSchema = z.object({
  repo: z.string().default('.'),
  agentId: agentIdSchema,
  verify: z
    .boolean()
    .optional()
    .describe(
      'Re-run full verification before teardown when the tree may have changed since the last passing --full',
    ),
  skipVerify: z
    .boolean()
    .optional()
    .describe(
      'Deprecated. Complete already skips re-verification by default. Pass verify=true to re-run; skipVerify=false still forces a re-run.',
    ),
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

/** Structured status is the source; text views render on top of it. */
export const GetStatusOutputSchema = EnvironmentStatusSchema;

export const MaintainHarnessInputSchema = z.object({
  repo: z.string().default('.'),
  finalize: z
    .boolean()
    .default(false)
    .describe('Record the completed manual adaptation in .har/manifest.json'),
  summary: z
    .string()
    .min(1)
    .max(512)
    .optional()
    .describe('Adaptation summary stored in the manifest (finalize only)'),
});

export const AddPluginInputSchema = z.object({
  repo: z.string().default('.'),
  plugin: z
    .string()
    .min(1)
    .describe('Bundled plugin id, local path (./plugin), npm package (@org/pkg), or git URL'),
  force: z.boolean().default(false).describe('Overwrite existing plugin files and stage entry'),
  withCi: z
    .boolean()
    .default(false)
    .describe('Also copy optional CI workflow files (skipped by default)'),
});

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

/** Factory lines (#304) — same core as `har line …`, mirrored on MCP. */
export const CreateLineInputSchema = z.object({
  repo: z.string().default('.'),
  id: z.string().min(1).describe('Line id (lowercase slug, e.g. onboarding-line)'),
  title: z.string().min(1).optional().describe('Human-readable line title'),
  description: z.string().min(1).max(2000).optional(),
  stations: z.array(z.string().min(1)).optional().describe('Station ids in order (default: S1, S2)'),
  gateStage: z
    .boolean()
    .default(true)
    .describe('Scaffold one registered-but-off-verify gate stage'),
  optInEnv: z
    .string()
    .min(1)
    .optional()
    .describe('Env var that must be "1" for the gate to run (e.g. HAR_FIXTURE_E2E)'),
  force: z.boolean().default(false),
});

export const AddLineInputSchema = z.object({
  repo: z.string().default('.'),
  line: z
    .string()
    .min(1)
    .describe('Line id, local path (./line), npm package (@org/pkg), or git URL (github:org/repo)'),
  force: z.boolean().default(false).describe('Overwrite existing line files and stage entries'),
});

export const LineStatusInputSchema = z.object({
  repo: z.string().default('.'),
  line: z.string().min(1).optional().describe('Line id (default: every installed line)'),
});

export const RunLineGateInputSchema = z.object({
  repo: z.string().default('.'),
  station: z.string().min(1).describe('Station id whose cumulative gate should run'),
  line: z.string().min(1).optional().describe('Line id when more than one is installed'),
  agentId: z.number().int().optional().describe('Agent slot to run the stages in'),
  force: z
    .boolean()
    .default(false)
    .describe('Run even when the program declares an opt-in env var that is not set'),
});
