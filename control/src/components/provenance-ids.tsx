function shortHash(value: string | null | undefined): string {
  if (!value) return '—';
  return value.length > 12 ? value.slice(0, 12) : value;
}

export function ProvenanceIds({
  commit,
  contentSnapshot,
  basedOn,
  verifiedByRun,
}: {
  commit: string | null;
  contentSnapshot: string | null;
  basedOn: string | null;
  verifiedByRun: string | null;
}) {
  const rows = [
    { label: 'Commit', value: commit, title: commit },
    { label: 'Content snapshot', value: contentSnapshot, title: contentSnapshot },
    { label: 'Based on', value: basedOn, title: basedOn },
    { label: 'Verified by run', value: verifiedByRun, title: verifiedByRun },
  ];
  return (
    <dl className="grid gap-2 sm:grid-cols-2" data-testid="provenance-ids">
      {rows.map((row) => (
        <div key={row.label} className="rounded-md border bg-muted/30 px-3 py-2">
          <dt className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            {row.label}
          </dt>
          <dd className="mt-0.5 font-mono text-sm" title={row.title ?? undefined}>
            {shortHash(row.value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}
