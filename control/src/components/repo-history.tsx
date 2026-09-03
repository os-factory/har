'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { HistoryGraphNode } from '@har/schemas';
import { ProvenanceIds } from '@/components/provenance-ids';
import { SessionHistoryGraph, shortHash } from '@/components/session-history-graph';
import { SlotTimeline } from '@/components/slot-timeline';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { SessionHistoryExplanation, SessionHistoryView } from '@/lib/session-history-view';
import { filterTimelineByBranch, timelineBranches, type TimelineRow } from '@/lib/slot-timeline';

const ALL_BRANCHES = '__all__';
const MAX_FILES = 12;
const NO_NODES: HistoryGraphNode[] = [];
const NO_EDGES: SessionHistoryView['graph']['edges'] = [];

function handoffBadge(node: HistoryGraphNode) {
  if (node.handoff === 'active') return <Badge variant="secondary">Active worktree</Badge>;
  if (node.handoff === 'retained') return <Badge variant="secondary">Retained branch</Badge>;
  return null;
}

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
    <div ref={ref} className="space-y-4 rounded-xl border p-4 scroll-mt-4" data-testid="session-history-explain">
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
            {files.length > MAX_FILES ? (
              <li className="text-muted-foreground">+{files.length - MAX_FILES} more</li>
            ) : null}
          </ul>
        </div>
      ) : null}

      <div>
        <h5 className="mb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">Verification</h5>
        {explanation.stages.length > 0 ? (
          <div className="flex flex-wrap gap-1.5" aria-label="Verification stages">
            {explanation.stages.map((stage) => (
              <Badge
                key={stage.name}
                variant={stage.lastStatus === 'pass' ? 'success' : stage.lastStatus === 'fail' ? 'destructive' : 'secondary'}
              >
                {stage.name}
                {stage.lastMs != null ? ` · ${stage.lastMs}ms` : ''}
              </Badge>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {node.runId ? 'Stage results for this run were not synced.' : 'No verify run is attached to this node.'}
          </p>
        )}
      </div>

      <div className="text-sm">
        <h5 className="mb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">Session intent</h5>
        {explanation.trajectory.firstPrompt ? (
          <p className="text-muted-foreground">“{explanation.trajectory.firstPrompt}”</p>
        ) : (
          <p className="text-muted-foreground">
            {explanation.trajectory.recordCount > 0
              ? `${explanation.trajectory.recordCount} trajectory records on this slot.`
              : 'No trajectory records attached to this slot yet.'}
          </p>
        )}
        {explanation.trajectory.agentId != null ? (
          <Link
            href={`/repos/${repositoryId}/slots/${explanation.trajectory.agentId}`}
            className="mt-1 inline-block text-sm underline"
          >
            Open slot {explanation.trajectory.agentId} →
          </Link>
        ) : null}
      </div>
    </div>
  );
}

export interface RepoHistoryProps {
  repositoryId: string;
  history: SessionHistoryView | null;
  timeline: TimelineRow[];
}

/**
 * History tab of a repository: a branch-lane graph of verified snapshots and the
 * commits that share their tree, plus a list mode reusing the slot timeline. One
 * branch filter drives both.
 */
export function RepoHistory({ repositoryId, history, timeline }: RepoHistoryProps) {
  const [branch, setBranch] = useState<string>(ALL_BRANCHES);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [howOpen, setHowOpen] = useState(false);

  const nodes = history?.graph.nodes ?? NO_NODES;
  const edges = history?.graph.edges ?? NO_EDGES;

  const branches = useMemo(() => {
    const names = new Set(timelineBranches(timeline));
    for (const node of nodes) if (node.branch) names.add(node.branch);
    return [...names].sort();
  }, [nodes, timeline]);

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

  const rows = useMemo(() => filterTimelineByBranch(timeline, selectedBranch), [timeline, selectedBranch]);

  const explanation =
    selectedId && visibleNodes.some((node) => node.id === selectedId) ? history?.explanations[selectedId] : undefined;

  return (
    <div className="space-y-4">
      <Collapsible open={howOpen} onOpenChange={setHowOpen}>
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
            {history?.lifecycleCopy}
          </p>
        </CollapsibleContent>
      </Collapsible>

      <Tabs defaultValue="graph">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <TabsList>
            <TabsTrigger value="graph">Graph</TabsTrigger>
            <TabsTrigger value="list">List</TabsTrigger>
          </TabsList>
          {branches.length > 0 ? (
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

        <TabsContent value="graph" className="mt-4 space-y-4">
          <SessionHistoryGraph nodes={visibleNodes} edges={visibleEdges} selectedId={selectedId} onSelect={setSelectedId} />
          {explanation ? (
            <Explanation explanation={explanation} repositoryId={repositoryId} />
          ) : visibleNodes.length > 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="session-history-explain-empty">
              Select a commit or snapshot in the graph to see how it was verified.
            </p>
          ) : null}
        </TabsContent>

        <TabsContent value="list" className="mt-4">
          <SlotTimeline
            repositoryId={repositoryId}
            rows={rows}
            showSlotColumn
            showBranchColumn
            searchPlaceholder="Search history…"
            emptyMessage={
              selectedBranch
                ? `Nothing recorded on ${selectedBranch} yet.`
                : 'Nothing recorded yet. Verify runs, snapshots, commits and agent sessions appear here as they happen.'
            }
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
