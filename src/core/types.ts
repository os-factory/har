import type { ShellResult } from '../utils/shell';
import type {
  RunRecordTriggerSchema,
  SlotReadiness,
  StageKind,
  StageResult,
  ValidationRecord,
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
  workUnitId?: string;
  attemptId?: string;
}

export interface LaunchFlags {
  worktree?: boolean;
  claude?: boolean;
  /** Resume a failed or partial launch without creating a new worktree. */
  resume?: boolean;
  workUnitId?: string;
  attemptId?: string;
}

export interface StageRunOptions {
  repoPath: string;
  stageId?: string;
  kind?: StageKind;
  agentId?: number;
  args?: string[];
  capture?: boolean;
  launchFlags?: LaunchFlags;
  workUnitId?: string;
  attemptId?: string;
}

export interface LaunchOptions {
  repoPath: string;
  agentId: number;
  worktree?: boolean;
  claude?: boolean;
  resume?: boolean;
  capture?: boolean;
  workUnitId?: string;
  source?: string;
  sourceUrl?: string;
  title?: string;
  parentWorkUnitId?: string;
}

export interface PreflightOptions {
  repoPath: string;
  agentId: number;
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
  workUnitId?: string;
  attemptId?: string;
  /** Launch refused because the slot is occupied — teardown/complete it first, then launch. */
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
  validation?: ValidationRecord;
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
