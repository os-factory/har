import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import type { AttentionItem } from '@/lib/attention';

export function AttentionPanel({ items }: { items: AttentionItem[] }) {
  if (items.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="attention-empty">
        Nothing needs attention. Every active slot is verified, clean and up to date.
      </p>
    );
  }
  return (
    <ul className="divide-y rounded-md border" data-testid="attention-list">
      {items.map((item) => (
        <li key={`${item.repoId}:${item.slotId}:${item.kind}`} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
          <Badge variant={item.severity === 'critical' ? 'destructive' : 'warning'}>
            {item.severity === 'critical' ? 'Fix' : 'Check'}
          </Badge>
          <Link href={`/repos/${item.repoId}/slots/${item.slotId}`} className="font-medium underline-offset-2 hover:underline">
            {item.repoName} · slot {item.slotId}
          </Link>
          <span className="text-muted-foreground">{item.message}</span>
        </li>
      ))}
    </ul>
  );
}
