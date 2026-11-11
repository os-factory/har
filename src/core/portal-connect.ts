import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { canonicalizeControlRepoPath } from './control-repo-path';
import { listRegisteredRepos, recordRepoForControlSync } from './control-registry';
import { loginViaBrowser } from './portal-login';
import { applyRepoWorkspaceMap } from './portal-repo-map';
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
  extraAttached: string[];
  mappedInBrowser: boolean;
}

function attachRepoIfPresent(alias: string, repoPath?: string): string | null {
  const resolved = path.resolve(repoPath ?? '.');
  if (!fs.existsSync(resolved)) return null;
  const canonical = canonicalizeControlRepoPath(resolved);
  attachRepoPortalTarget(canonical, alias);
  recordRepoForControlSync(canonical);
  return canonical;
}

function workspaceIdForApiKey(token: string): string {
  return `key:${createHash('sha256').update(token).digest('hex').slice(0, 12)}`;
}

export async function runPortalConnect(input: PortalConnectInput): Promise<PortalConnectResult> {
  if (input.apiKey) {
    const record = upsertPortalTarget({
      alias: input.alias,
      portalUrl: input.portalUrl,
      workspaceId: workspaceIdForApiKey(input.apiKey),
      token: input.apiKey,
      setAsDefault: true,
    });
    return {
      record,
      attachedRepo: attachRepoIfPresent(record.alias, input.repoPath),
      extraAttached: [],
      mappedInBrowser: false,
    };
  }

  const creds = await loginViaBrowser(input.portalUrl, {
    repos: listRegisteredReposForConnect(input.repoPath),
  });
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
  const attachedRepo = attachRepoIfPresent(record.alias, input.repoPath);
  if (!creds.targets || creds.targets.length === 0) {
    return { record, attachedRepo, extraAttached: [], mappedInBrowser: false };
  }

  const extraAttached: string[] = [];
  for (const target of creds.targets) {
    const next = upsertPortalTarget({
      portalUrl: input.portalUrl,
      workspaceId: target.workspaceId,
      workspace: target.workspace,
      workspaceSlug: target.workspace,
      workspaceName: target.workspaceName,
      token: target.token,
      refreshToken: target.refreshToken,
      expiresAt: target.expiresAt,
      email: creds.email,
      setAsDefault: false,
    });
    const attached = applyRepoWorkspaceMap(
      target.repos.map((repoPath) => ({ repoPath, alias: next.alias })),
    );
    extraAttached.push(...attached.filter((repoPath) => repoPath !== attachedRepo));
  }
  return { record, attachedRepo, extraAttached, mappedInBrowser: true };
}

function listRegisteredReposForConnect(repoPath?: string): string[] {
  const resolved = repoPath ? path.resolve(repoPath) : null;
  const current = resolved && fs.existsSync(resolved) ? canonicalizeControlRepoPath(resolved) : null;
  return [...new Set([...(current ? [current] : []), ...listRegisteredRepos()])];
}
