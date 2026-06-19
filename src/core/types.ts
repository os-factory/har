import type { ShellResult } from '../utils/shell';
import type { RunRecordTriggerSchema, StageKind, StageResult, VerificationResult } from '../harness/schema';
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
  capture?: boolean;
}

export interface EnvironmentRunResult {
  code: number;
  stdout: string;
  stderr: string;
  previewUrls?: Record<string, string>;
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
