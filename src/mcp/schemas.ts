import { z } from 'zod';
import {
  HAR_AGENT_SLOT_MIN,
  HarnessManifestSchema,
  HarnessStageSchema,
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
  worktree: z.boolean().default(false),
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

export { StageResultSchema };
