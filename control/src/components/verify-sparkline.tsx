/** Pass/fail per day as a small bar strip. Server-renderable, theme colours via currentColor classes. */
export function VerifySparkline({ data }: { data: { date: string; pass: number; fail: number }[] }) {
  if (data.length === 0) return null;
  const width = 120;
  const height = 28;
  const gap = 2;
  const bar = Math.max(2, Math.floor((width - gap * (data.length - 1)) / data.length));
  const max = Math.max(1, ...data.map((d) => d.pass + d.fail));
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`Verify runs per day over ${data.length} days`}
      className="overflow-visible"
    >
      {data.map((d, i) => {
        const total = d.pass + d.fail;
        const h = Math.max(2, Math.round((total / max) * height));
        const passH = total > 0 ? Math.round((d.pass / total) * h) : 0;
        const x = i * (bar + gap);
        return (
          <g key={d.date}>
            <title>{`${d.date}: ${d.pass} pass, ${d.fail} fail`}</title>
            {d.fail > 0 && (
              <rect x={x} y={height - h} width={bar} height={h - passH} className="fill-destructive/70" />
            )}
            <rect x={x} y={height - passH} width={bar} height={passH} className="fill-emerald-600/80" />
          </g>
        );
      })}
    </svg>
  );
}
