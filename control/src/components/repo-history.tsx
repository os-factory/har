'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { HistoryGraphNode } from '@har/schemas';
import { AttemptRecordPanel } from '@/components/attempt-record-panel';
import { ProvenanceIds } from '@/components/provenance-ids';
import { SessionHistoryGraph, shortHash } from '@/components/session-history-graph';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { SessionHistoryExplanation, SessionHistoryView } from '@/lib/session-history-view';

const ALL_BRANCHES = '__all__';
const MAX_FILES = 12;
const NO_NODES: HistoryGraphNode[] = [];
const NO_EDGES: SessionHistoryView['graph']['edges'] = [];

function handoffBadge(node: HistoryGraphNode) {
  if (node.handoff === 'active') return <Badge variant="secondary">Active worktree</Badge>;
  if (node.handoff === 'retained') return <Badge variant="secondary">Retained branch</Badge>;
  return null;
}

/**
 * Detail of the selected node: what the tree is, then the record of the attempt that
 * produced it (#348). No link to a slot — the slot may hold other work by now.
 */
function Explanation({ explanation, repositoryId }: { explanation: SessionHistoryExplanation; repositoryId: string }) {
  const { node } = explanation;
  const verified = node.full && node.status === 'pass';
  const subject = node.pending ? `Snapshot ${shortHash(node.treeHash)}` : `Commit ${shortHash(node.commitSha)}`;
  const message = node.message?.split('\n')[0];
  const files = explanation.changedFiles;
  const ref = useRef<HTMLDivElement>(null);

  // The graph can be 600px tall, so the panel is usually below the fold when a node is
  // clicked: bring it into view each time the selection changes.
  useEffect(() => {
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [node.id]);

  return (
    <div ref={ref} className="space-y-6 rounded-xl border p-4 scroll-mt-4" data-testid="session-history-explain">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="text-sm font-medium">{subject}</h4>
          {handoffBadge(node)}
          {verified ? <Badge variant="success">Exact-tree verified</Badge> : null}
          {node.status === 'fail' ? <Badge variant="destructive">Verify failed</Badge> : null}
          {!node.full && node.status === 'pass' ? <Badge variant="warning">Partial verify</Badge> : null}
          {explanation.reusedProof ? (
            <Badge variant="secondary">Proof reused on {node.matchingCommitCount} commits</Badge>
          ) : null}
          {node.branch ? <code className="font-mono text-xs text-muted-foreground">{node.branch}</code> : null}
        </div>
        {message ? <p className="text-sm text-muted-foreground">{message}</p> : null}
      </div>

      <ProvenanceIds {...explanation.provenance} />

      {files.length > 0 ? (
        <div>
          <h5 className="mb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {files.length} changed file{files.length === 1 ? '' : 's'} vs base
          </h5>
          <ul className="font-mono text-xs">
            {files.slice(0, MAX_FILES).map((file) => (
              <li key={`${file.status}:${file.path}`}>
                <span className="inline-block w-4 text-muted-foreground">{file.status}</span>
                {file.path}
              </li>
            ))}
            {files.length > MAX_FILES ? <li className="text-muted-foreground">+{files.length - MAX_FILES} more</li> : null}
          </ul>
        </div>
      ) : null}

      {node.occupancyKey ? (
        <AttemptRecordPanel repositoryId={repositoryId} occupancyKey={node.occupancyKey} />
      ) : (
        <p className="text-sm text-muted-foreground" data-testid="session-history-no-attempt">
          {node.pending || node.treeHash
            ? 'The attempt behind this tree was not synchronized, so there is no verification or trajectory to show.'
            : 'A base commit: sessions were launched from it, but no attempt produced it.'}
        </p>
      )}
    </div>
  );
}

export interface RepoHistoryProps {
  repositoryId: string;
  history: SessionHistoryView | null;
}

/**
 * History tab of a repository (#338, #348): a branch-lane graph of verified snapshots
 * and the commits that share their tree. Selecting a node opens the record of the
 * attempt that produced it — verification, timeline, trajectory and work unit.
 */
export function RepoHistory({ repositoryId, history }: RepoHistoryProps) {
  const [branch, setBranch] = useState<string>(ALL_BRANCHES);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [howOpen, setHowOpen] = useState(false);

  const nodes = history?.graph.nodes ?? NO_NODES;
  const edges = history?.graph.edges ?? NO_EDGES;

  const branches = useMemo(
    () => [...new Set(nodes.map((node) => node.branch).filter((name): name is string => Boolean(name)))].sort(),
    [nodes],
  );

  const selectedBranch = branch === ALL_BRANCHES ? null : branch;

  const { visibleNodes, visibleEdges } = useMemo(() => {
    if (!selectedBranch) return { visibleNodes: nodes, visibleEdges: edges };
    const ids = new Set(nodes.filter((node) => node.branch === selectedBranch).map((node) => node.id));
    // Keep the commits the branch is based on, so the based-on edges stay visible.
    for (const edge of edges) if (ids.has(edge.target)) ids.add(edge.source);
    return {
      visibleNodes: nodes.filter((node) => ids.has(node.id)),
      visibleEdges: edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)),
    };
  }, [nodes, edges, selectedBranch]);

  const explanation =
    selectedId && visibleNodes.some((node) => node.id === selectedId) ? history?.explanations[selectedId] : undefined;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Collapsible open={howOpen} onOpenChange={setHowOpen} className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
            <span>Each full verify records a snapshot of the worktree; a commit whose tree matches it inherits the proof.</span>
            <CollapsibleTrigger asChild>
              <Button variant="link" size="sm" className="h-auto p-0 text-sm" data-testid="history-how-toggle">
                {howOpen ? <ChevronDown className="mr-0.5 size-3.5" /> : <ChevronRight className="mr-0.5 size-3.5" />}
                How does this work?
              </Button>
            </CollapsibleTrigger>
          </div>
          <CollapsibleContent>
            <p className="mt-2 rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground" data-testid="handoff-lifecycle-copy">
              {history?.lifecycleCopy} Click a commit or snapshot to see the attempt that produced it: how the tree was
              verified, what the agent did, and which work unit it served. Slots are not linked from here — a slot shows
              whatever it is running now.
            </p>
          </CollapsibleContent>
        </Collapsible>
        {branches.length > 1 ? (
          <Select value={branch} onValueChange={setBranch}>
            <SelectTrigger className="h-8 w-[min(22rem,100%)] font-mono text-xs" aria-label="Filter history by branch">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_BRANCHES} className="font-sans">
                All branches ({branches.length})
              </SelectItem>
              {branches.map((name) => (
                <SelectItem key={name} value={name} className="font-mono text-xs">
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
      </div>

      <SessionHistoryGraph nodes={visibleNodes} edges={visibleEdges} selectedId={selectedId} onSelect={setSelectedId} />
      {explanation ? (
        <Explanation explanation={explanation} repositoryId={repositoryId} />
      ) : visibleNodes.length > 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="session-history-explain-empty">
          Select a commit or snapshot in the graph to see how it was verified and what the agent did.
        </p>
      ) : null}
    </div>
  );
}
