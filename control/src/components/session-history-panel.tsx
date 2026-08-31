'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import type { HistoryGraphNode } from '@har/schemas';
import { Badge } from '@/components/ui/badge';
import { ProvenanceIds } from '@/components/provenance-ids';
import { SessionHistoryGraph } from '@/components/session-history-graph';
import type { SessionHistoryExplanation, SessionHistoryView } from '@/lib/session-history-view';

function handoffLabel(node: HistoryGraphNode): string {
  if (node.handoff === 'active') return 'Active worktree';
  if (node.handoff === 'retained') return 'Retained branch';
  return 'History';
}

export function SessionHistoryPanel({ history }: { history: SessionHistoryView }) {
  const [branch, setBranch] = useState<string>('all');
  const [selectedId, setSelectedId] = useState<string | null>(history.graph.nodes[0]?.id ?? null);

  const branches = useMemo(
    () =>
      [...new Set(history.graph.nodes.map((node) => node.branch).filter((value): value is string => Boolean(value)))].sort(),
    [history.graph.nodes],
  );

  const visibleNodes = useMemo(
    () =>
      history.graph.nodes.filter((node) => branch === 'all' || node.branch === branch || !node.branch),
    [history.graph.nodes, branch],
  );
  const visibleIds = new Set(visibleNodes.map((node) => node.id));
  const visibleEdges = history.graph.edges.filter(
    (edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target),
  );

  const explanation: SessionHistoryExplanation | undefined = selectedId
    ? history.explanations[selectedId]
    : undefined;

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground" data-testid="handoff-lifecycle-copy">
        {history.lifecycleCopy}
      </p>
      {branches.length > 1 && (
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Branch</span>
          <select
            className="rounded-md border bg-background px-2 py-1"
            value={branch}
            onChange={(event) => setBranch(event.target.value)}
            aria-label="Filter history by branch"
          >
            <option value="all">All branches</option>
            {branches.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
      )}
      <SessionHistoryGraph
        nodes={visibleNodes}
        edges={visibleEdges}
        selectedId={selectedId}
        onSelect={setSelectedId}
      />
      {explanation && (
        <div className="space-y-4 rounded-xl border p-4" data-testid="session-history-explain">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-sm font-medium">
              {explanation.node.pending ? 'Explain this snapshot' : 'Explain this commit'}
            </h4>
            <Badge variant="secondary">{handoffLabel(explanation.node)}</Badge>
            {explanation.node.full && explanation.node.status === 'pass' && (
              <Badge variant="success">Exact-tree verified</Badge>
            )}
            {explanation.reusedProof && (
              <Badge variant="secondary">Proof reused on {explanation.node.matchingCommitCount} commits</Badge>
            )}
          </div>
          <ProvenanceIds {...explanation.provenance} />
          {explanation.changedFiles.length > 0 && (
            <div>
              <h5 className="mb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Changed files vs base
              </h5>
              <ul className="font-mono text-xs">
                {explanation.changedFiles.slice(0, 12).map((file) => (
                  <li key={`${file.status}:${file.path}`}>
                    {file.status} {file.path}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {explanation.stages.length > 0 && (
            <div className="flex flex-wrap gap-1.5" aria-label="Verification stages">
              {explanation.stages.map((stage) => (
                <Badge
                  key={stage.name}
                  variant={
                    stage.lastStatus === 'pass'
                      ? 'success'
                      : stage.lastStatus === 'fail'
                        ? 'destructive'
                        : 'secondary'
                  }
                >
                  {stage.name}
                  {stage.lastMs != null ? ` · ${stage.lastMs}ms` : ''}
                </Badge>
              ))}
            </div>
          )}
          <div className="text-sm">
            <h5 className="mb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Session intent
            </h5>
            {explanation.trajectory.firstPrompt ? (
              <p className="text-muted-foreground">“{explanation.trajectory.firstPrompt}”</p>
            ) : (
              <p className="text-muted-foreground">
                {explanation.trajectory.recordCount > 0
                  ? `${explanation.trajectory.recordCount} trajectory records on this slot.`
                  : 'No trajectory records attached to this slot yet.'}
              </p>
            )}
            {explanation.trajectory.slotHref && (
              <Link href={explanation.trajectory.slotHref} className="mt-1 inline-block text-sm underline">
                Open slot trajectory →
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
