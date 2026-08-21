import * as fs from 'fs';
import * as path from 'path';
import { canonicalizeControlRepoPath } from './control-repo-path';
import { recordRepoForControlSync } from './control-registry';
import { loginViaBrowser } from './portal-login';
import {
  attachRepoPortalTarget,
  upsertPortalTarget,
  type PortalTargetRecord,
} from './portal-targets';

export interface PortalConnectInput {
  portalUrl: string;
  apiKey?: string;
  repoPath?: string;
  /** Optional alias override (deprecated `har control login --target`). */
  alias?: string;
}

export interface PortalConnectResult {
  record: PortalTargetRecord;
  attachedRepo: string | null;
}

function attachRepoIfPresent(alias: string, repoPath?: string): string | null {
  const resolved = path.resolve(repoPath ?? '.');
  if (!fs.existsSync(resolved)) return null;
  const canonical = canonicalizeControlRepoPath(resolved);
  attachRepoPortalTarget(canonical, alias);
  recordRepoForControlSync(canonical);
  return canonical;
}

export async function runPortalConnect(input: PortalConnectInput): Promise<PortalConnectResult> {
  if (input.apiKey) {
    const record = upsertPortalTarget({
      alias: input.alias,
      portalUrl: input.portalUrl,
      token: input.apiKey,
      setAsDefault: true,
    });
    return { record, attachedRepo: attachRepoIfPresent(record.alias, input.repoPath) };
  }

  const creds = await loginViaBrowser(input.portalUrl);
  const record = upsertPortalTarget({
    alias: input.alias,
    portalUrl: input.portalUrl,
    workspaceId: creds.workspaceId,
    workspace: creds.workspace,
    workspaceSlug: creds.workspaceSlug,
    workspaceName: creds.workspaceName,
    token: creds.token,
    refreshToken: creds.refreshToken,
    expiresAt: creds.expiresAt,
    email: creds.email,
    setAsDefault: true,
  });
  return { record, attachedRepo: attachRepoIfPresent(record.alias, input.repoPath) };
}
