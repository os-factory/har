import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { canonicalizeControlRepoPath } from './control-repo-path';
import { isRepoPortalSyncEnabled, listRegisteredRepos, recordRepoForControlSync } from './control-registry';
import { loginViaBrowser } from './portal-login';
import {
  attachRepoToPortal,
  connectPortal,
  readPortalConnectionState,
  type ConnectPortalResult,
  type PortalTargetRecord,
} from './portal-targets';
import { getTelemetryLevel, type TelemetryLevel } from './telemetry-config';

export interface PortalConnectInput {
  portalUrl: string;
  apiKey?: string;
  repoPath?: string;
}

export interface PortalConnectResult {
  record: PortalTargetRecord;
  attachedRepo: string | null;
  /** The different org this connect replaced (nothing is sent to it any more). */
  replaced: PortalTargetRecord | null;
  /** Repos attached to the replaced org; they no longer sync until re-attached. */
  detachedRepos: string[];
}

function attachRepoIfPresent(repoPath?: string): string | null {
  const resolved = path.resolve(repoPath ?? '.');
  if (!fs.existsSync(resolved)) return null;
  const canonical = canonicalizeControlRepoPath(resolved);
  attachRepoToPortal(canonical);
  recordRepoForControlSync(canonical);
  return canonical;
}

function workspaceIdForApiKey(token: string): string {
  return `key:${createHash('sha256').update(token).digest('hex').slice(0, 12)}`;
}

/**
 * Connect the CLI to one org. This replaces any existing connection to a
 * different org — the CLI never holds keys for several orgs.
 */
export async function runPortalConnect(input: PortalConnectInput): Promise<PortalConnectResult> {
  const connected = input.apiKey
    ? connectPortal({
        portalUrl: input.portalUrl,
        workspaceId: workspaceIdForApiKey(input.apiKey),
        token: input.apiKey,
      })
    : await connectViaBrowser(input);

  return {
    record: connected.record,
    attachedRepo: attachRepoIfPresent(input.repoPath),
    replaced: connected.replaced,
    detachedRepos: connected.detachedRepos,
  };
}

async function connectViaBrowser(input: PortalConnectInput): Promise<ConnectPortalResult> {
  const creds = await loginViaBrowser(input.portalUrl, {
    repos: listRegisteredReposForConnect(input.repoPath),
  });
  return connectPortal({
    portalUrl: input.portalUrl,
    workspaceId: creds.workspaceId,
    workspace: creds.workspace,
    workspaceSlug: creds.workspaceSlug,
    workspaceName: creds.workspaceName,
    token: creds.token,
    refreshToken: creds.refreshToken,
    expiresAt: creds.expiresAt,
    email: creds.email,
  });
}

function listRegisteredReposForConnect(repoPath?: string): string[] {
  const resolved = repoPath ? path.resolve(repoPath) : null;
  const current = resolved && fs.existsSync(resolved) ? canonicalizeControlRepoPath(resolved) : null;
  return [...new Set([...(current ? [current] : []), ...listRegisteredRepos()])];
}

export interface PortalRepoSyncState {
  repoPath: string;
  /** False when the repo is attached but kept local-only (`register --no-portal`). */
  sendsToHq: boolean;
}

/** What HQ actually receives from this machine, as `har hq list` reports it. */
export interface PortalSyncOverview {
  connection: PortalTargetRecord | null;
  repos: PortalRepoSyncState[];
  /** Whether prompts and tool text are forwarded, when the level records them. */
  trajectoryForwarding: boolean;
  telemetryLevel: TelemetryLevel;
  /** What a synced repo's sessions look like in HQ, from the two settings above. */
  hqTrajectory: 'none' | 'usage' | 'outline' | 'full';
}

export function describePortalSync(): PortalSyncOverview {
  const { connection, attachedRepos } = readPortalConnectionState();
  const telemetryLevel = getTelemetryLevel();
  const trajectoryForwarding = connection?.trajectoryForwarding === true;
  const hqTrajectory: PortalSyncOverview['hqTrajectory'] =
    telemetryLevel === 'off'
      ? 'none'
      : telemetryLevel === 'full'
        ? trajectoryForwarding
          ? 'full'
          : 'outline'
        : telemetryLevel;
  return {
    connection,
    repos: attachedRepos.map((repoPath) => ({
      repoPath,
      sendsToHq: isRepoPortalSyncEnabled(repoPath),
    })),
    trajectoryForwarding,
    telemetryLevel,
    hqTrajectory,
  };
}
