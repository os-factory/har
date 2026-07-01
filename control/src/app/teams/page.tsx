import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export default function TeamsPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Team dashboards</CardTitle>
        <CardDescription>HAR Cloud paid feature (Phase 4)</CardDescription>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground space-y-2">
        <p>Planned capabilities:</p>
        <ul className="list-disc pl-5 space-y-1">
          <li>Cross-developer run history and ownership</li>
          <li>Cost telemetry for model and compute usage</li>
          <li>GitHub, Linear, and Slack integrations</li>
          <li>Harness drift detection on pull requests</li>
          <li>Policy controls and hosted previews</li>
        </ul>
      </CardContent>
    </Card>
  );
}
