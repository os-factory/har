import { prisma } from '@/lib/db';

export interface CloudBridgeConfig {
  enabled: boolean;
  apiUrl: string | null;
  hasApiKey: boolean;
}

export async function getCloudBridgeConfig(): Promise<CloudBridgeConfig> {
  const config = await prisma.cloudConfig.findUnique({ where: { id: 'default' } });
  return {
    enabled: config?.enabled ?? false,
    apiUrl: config?.apiUrl ?? null,
    hasApiKey: Boolean(config?.apiKey),
  };
}

export async function updateCloudBridgeConfig(input: {
  enabled?: boolean;
  apiUrl?: string | null;
  apiKey?: string | null;
}): Promise<CloudBridgeConfig> {
  const config = await prisma.cloudConfig.upsert({
    where: { id: 'default' },
    create: {
      id: 'default',
      enabled: input.enabled ?? false,
      apiUrl: input.apiUrl ?? null,
      apiKey: input.apiKey ?? null,
    },
    update: {
      enabled: input.enabled,
      apiUrl: input.apiUrl,
      apiKey: input.apiKey,
    },
  });

  return {
    enabled: config.enabled,
    apiUrl: config.apiUrl,
    hasApiKey: Boolean(config.apiKey),
  };
}

/** Phase 3 stub — push sync payload to HAR Cloud when enabled. */
export async function pushToCloud(payload: unknown): Promise<{ ok: boolean; message: string }> {
  const config = await getCloudBridgeConfig();
  if (!config.enabled || !config.apiUrl) {
    return { ok: false, message: 'Cloud sync disabled' };
  }

  const row = await prisma.cloudConfig.findUnique({ where: { id: 'default' } });
  if (!row?.apiKey) {
    return { ok: false, message: 'HAR Cloud API key not configured' };
  }

  try {
    const response = await fetch(`${config.apiUrl}/api/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${row.apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return { ok: false, message: `Cloud API ${response.status}: ${text}` };
    }

    return { ok: true, message: 'Synced to HAR Cloud' };
  } catch (err: unknown) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
