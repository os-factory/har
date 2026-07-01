import { StageExecutor, ExecutionContext, StageRunOptions } from './types';
import { StageResult } from '../harness/schema';

/**
 * Phase 3 — HAR Cloud remote executor stub.
 * Implements StageExecutor against hosted HAR Cloud API when ExecutionTarget is 'cloud'.
 */
export class RemoteExecutor implements StageExecutor {
  constructor(
    private readonly apiUrl: string,
    private readonly apiKey: string,
  ) {}

  async runStage(_ctx: ExecutionContext, _options: StageRunOptions): Promise<StageResult> {
    throw new Error(
      'RemoteExecutor is not yet implemented. Use local harness execution or enable HAR Cloud when available.',
    );
  }

  listArtifacts(): never[] {
    return [];
  }
}

export function createRemoteExecutor(apiUrl?: string, apiKey?: string): RemoteExecutor | null {
  const url = apiUrl ?? process.env.HAR_CLOUD_API_URL;
  const key = apiKey ?? process.env.HAR_CLOUD_API_KEY;
  if (!url || !key) return null;
  return new RemoteExecutor(url, key);
}
