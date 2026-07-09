import type { ShellResult } from '../utils/shell';
import type {
  RunRecordTriggerSchema,
  SlotReadiness,
  StageKind,
  StageResult,
  VerificationResult,
} from '../harness/schema';
import { z } from 'zod';

export type ShellRunResult = ShellResult;

/** Future: RemoteExecutor implements StageExecutor against HAR Cloud API */
export type ExecutionTarget = 'local' | 'cloud';

export interface ExecutionContext {
  repoPath: string;
  capture?: boolean;
  agentId?: number;
  trigger?: z.infer<typeof RunRecordTriggerSchema>;
}

export interface LaunchFlags {
  worktree?: boolean;
  claude?: boolean;
  /** Explicitly replace an occupied slot (required when a session is already active). */
  confirmReplace?: boolean;
  /** Discard a dirty previous session instead of refusing to replace it. Requires confirmReplace. */
  force?: boolean;
  /** Resume a failed or partial launch without creating a new worktree. */
  resume?: boolean;
}

export interface StageRunOptions {
  repoPath: string;
  stageId?: string;
  kind?: StageKind;
  agentId?: number;
  args?: string[];
  capture?: boolean;
  launchFlags?: LaunchFlags;
}

export interface LaunchOptions {
  repoPath: string;
  agentId: number;
  worktree?: boolean;
  claude?: boolean;
  confirmReplace?: boolean;
  force?: boolean;
  resume?: boolean;
  capture?: boolean;
}

export interface PreflightOptions {
  repoPath: string;
  agentId: number;
  confirmReplace?: boolean;
  force?: boolean;
}

export interface PreflightResult {
  code: number;
  stdout: string;
  stderr: string;
  readiness: SlotReadiness;
  blocked?: boolean;
}

export interface EnvironmentRunResult {
  code: number;
  stdout: string;
  stderr: string;
  previewUrls?: Record<string, string>;
  /** Where the session's code lives — all agent edits must go under this path. */
  workDir?: string;
  worktreePath?: string;
  branch?: string;
  /** Launch refused because the slot is occupied and confirmReplace was not set. */
  blocked?: boolean;
  occupiedSlot?: {
    agentId: number;
    workDir?: string;
    worktreePath?: string;
    branch?: string;
    dirty?: boolean;
    sessionCreatedAt?: string;
  };
}

export interface VerificationRunResult extends EnvironmentRunResult {
  verification: VerificationResult | null;
}

export interface LogsOptions {
  repoPath: string;
  agentId: number;
  service?: string;
  lines?: number;
}

export interface ArtifactEntry {
  path: string;
  relativePath: string;
  sizeBytes: number;
  modifiedAt: string;
}

export interface StageExecutor {
  runStage(ctx: ExecutionContext, options: StageRunOptions): Promise<StageResult>;
  listArtifacts(ctx: ExecutionContext, filter?: { stageId?: string }): ArtifactEntry[];
}
