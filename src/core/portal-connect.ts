import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { canonicalizeControlRepoPath } from './control-repo-path';
import type { DestinationRepository } from '../harness/schema';
import { listRegisteredRepos } from './control-registry';
import { hqDestination } from './hq-repositories';
import { hqStatusHint } from './hq-upgrade';
import { detectOtelHookFeatures } from './otel-hooks';
import { loginViaBrowser } from './portal-login';
import {
  connectPortal,
  readPortalConnectionState,
  type ConnectPortalResult,
  type PortalTargetRecord,
} from './portal-targets';
import { getTelemetryLevel, type TelemetryLevel } from './telemetry-config';
import { readDestinations } from './telemetry-destinations';

export interface PortalConnectInput {
  portalUrl: string;
  apiKey?: string;
  /** Repository the login page lists first (nothing is attached or sent by logging in). */
  repoPath?: string;
}

export interface PortalConnectResult {
  record: PortalTargetRecord;
  /** The different org this connect replaced (nothing is sent to it any more). */
  replaced: PortalTargetRecord | null;
}

function workspaceIdForApiKey(token: string): string {
  return `key:${createHash('sha256').update(token).digest('hex').slice(0, 12)}`;
}

/**
 * Log the CLI in to one org. This replaces any existing connection to a
 * different org — the CLI never holds keys for several orgs. Logging in sends
 * nothing: HAR HQ receives only the repositories chosen afterwards
 * (`hq-repositories.ts`).
 */
export async function runPortalConnect(input: PortalConnectInput): Promise<PortalConnectResult> {
  const connected = input.apiKey
    ? connectPortal({
        portalUrl: input.portalUrl,
        workspaceId: workspaceIdForApiKey(input.apiKey),
        token: input.apiKey,
      })
    : await connectViaBrowser(input);
  return { record: connected.record, replaced: connected.replaced };
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

/** What HAR HQ receives from this machine, as `har hq status` reports it. */
export interface HqStatus {
  connection: PortalTargetRecord | null;
  /** `HAR_PORTAL_TOKEN` is set (CI): sends without a stored login. */
  envToken: boolean;
  /** The chosen repositories and their scopes (the `hq` destination's). */
  repositories: DestinationRepository[];
  /** The `hq` destination exists and is enabled. */
  destinationEnabled: boolean;
  /** The local level caps what any destination can get. */
  telemetryLevel: TelemetryLevel;
  /** The installed otel-hook filters by repository; without it HAR HQ gets no agent telemetry. */
  agentTelemetryScoped: boolean | null;
  /** One informational line (logged out by the upgrade, nothing chosen). */
  hint?: string;
}

export function describeHqStatus(env: NodeJS.ProcessEnv = process.env): HqStatus {
  const { connection } = readPortalConnectionState();
  let destination: ReturnType<typeof hqDestination>;
  try {
    destination = hqDestination(readDestinations(env).destinations);
  } catch {
    destination = undefined;
  }
  const features = detectOtelHookFeatures();
  const hint = hqStatusHint(env);
  return {
    connection,
    envToken: Boolean(env.HAR_PORTAL_TOKEN?.trim()),
    repositories: destination?.repositories ?? [],
    destinationEnabled: destination?.enabled === true,
    telemetryLevel: getTelemetryLevel(),
    agentTelemetryScoped: features ? features.scopes : null,
    ...(hint ? { hint } : {}),
  };
}
