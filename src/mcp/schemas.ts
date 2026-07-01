import { z } from 'zod';
import {
  HAR_AGENT_SLOT_MIN,
  HarnessManifestSchema,
  HarnessStageSchema,
  RunRecordSchema,
  ShellRunOutputSchema,
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
  profile: z.enum(['default', 'cli']).default('default'),
});

export const LaunchEnvironmentInputSchema = z.object({
  repo: z.string().default('.'),
  agentId: agentIdSchema,
  worktree: z.boolean().default(true),
  claude: z.boolean().default(false),
});

export const LaunchEnvironmentOutputSchema = ShellRunOutputSchema.extend({
  previewUrls: z.record(z.string()).optional(),
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

export { StageResultSchema };
