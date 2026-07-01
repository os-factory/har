import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getCloudBridgeConfig } from '@/server/cloud-bridge';

export const dynamic = 'force-dynamic';

export default async function CloudPage() {
  const config = await getCloudBridgeConfig();

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>HAR Cloud bridge</CardTitle>
          <CardDescription>
            Opt-in sync to hosted HAR Cloud (paid). Configure via API or environment.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>
            <span className="font-medium">Enabled:</span> {config.enabled ? 'Yes' : 'No'}
          </p>
          <p>
            <span className="font-medium">API URL:</span> {config.apiUrl ?? '—'}
          </p>
          <p>
            <span className="font-medium">API key:</span> {config.hasApiKey ? 'Configured' : 'Not set'}
          </p>
          <p className="text-muted-foreground">
            Set <code className="rounded bg-muted px-1">HAR_CLOUD_API_KEY</code> on the CLI and enable
            cloud sync with <code className="rounded bg-muted px-1">har control sync --cloud</code>{' '}
            (Phase 3).
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
