import type { HistoryGraphNode, HistoryProvenance, SessionHistoryGraph } from '@har/schemas';

export interface SessionHistoryStageBadge {
  name: string;
  lastStatus: 'pass' | 'fail' | null;
  lastMs: number | null;
}

export interface SessionHistoryExplanation {
  node: HistoryGraphNode;
  provenance: HistoryProvenance;
  stages: SessionHistoryStageBadge[];
  changedFiles: { path: string; status: string; oldPath?: string }[];
  trajectory: {
    agentId: number | null;
    recordCount: number;
    firstPrompt: string | null;
    slotHref: string | null;
  };
  reusedProof: boolean;
}

export interface SessionHistoryView {
  graph: SessionHistoryGraph;
  lifecycleCopy: string;
  explanations: Record<string, SessionHistoryExplanation>;
}
