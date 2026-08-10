import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { writeFileSafe } from '../utils/file-ops';
import { info, warn } from '../utils/logging';
import { getHarnessDir } from './manifest';
import {
  AGENTS_MD,
  AgentsMdShrinkError,
  extractOutsideHarSection,
  mergeAgentsMdContent,
  upsertAgentsMdHarSection,
} from './instruction-files';

export const AGENTS_MD_PROPOSAL = 'AGENTS.md.proposed';
export const AGENTS_MD_PROPOSAL_META = 'AGENTS.md.proposed.meta.json';

/** @deprecated Legacy proposal filenames — still read for backward compatibility. */
export const AGENT_MD_PROPOSAL = 'AGENT.md.proposed';
/** @deprecated */
export const AGENT_MD_PROPOSAL_META = 'AGENT.md.proposed.meta.json';

export interface AgentMdProposal {
  content: string;
  rationale: string;
  createdAt: string;
}

export function writeAgentMdProposal(
  repoPath: string,
  content: string,
  rationale: string,
): void {
  const harnessDir = getHarnessDir(repoPath);
  writeFileSafe(path.join(harnessDir, AGENTS_MD_PROPOSAL), content);
  writeFileSafe(
    path.join(harnessDir, AGENTS_MD_PROPOSAL_META),
    JSON.stringify({ rationale, createdAt: new Date().toISOString() }, null, 2) + '\n',
  );
  // Clear legacy proposal names if present
  for (const file of [AGENT_MD_PROPOSAL, AGENT_MD_PROPOSAL_META]) {
    const p = path.join(harnessDir, file);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}

export function readAgentMdProposal(repoPath: string): AgentMdProposal | null {
  const harnessDir = getHarnessDir(repoPath);
  const proposalPath = path.join(harnessDir, AGENTS_MD_PROPOSAL);
  const metaPath = path.join(harnessDir, AGENTS_MD_PROPOSAL_META);
  const legacyProposalPath = path.join(harnessDir, AGENT_MD_PROPOSAL);
  const legacyMetaPath = path.join(harnessDir, AGENT_MD_PROPOSAL_META);

  const resolvedProposal = fs.existsSync(proposalPath)
    ? proposalPath
    : fs.existsSync(legacyProposalPath)
      ? legacyProposalPath
      : null;
  if (!resolvedProposal) return null;

  const resolvedMeta = resolvedProposal === proposalPath ? metaPath : legacyMetaPath;
  const content = fs.readFileSync(resolvedProposal, 'utf8');
  let rationale = '';
  let createdAt = new Date().toISOString();
  if (fs.existsSync(resolvedMeta)) {
    try {
      const meta = JSON.parse(fs.readFileSync(resolvedMeta, 'utf8'));
      rationale = meta.rationale ?? '';
      createdAt = meta.createdAt ?? createdAt;
    } catch {
      rationale = '';
    }
  }

  return { content, rationale, createdAt };
}

export function clearAgentMdProposal(repoPath: string): void {
  const harnessDir = getHarnessDir(repoPath);
  for (const file of [
    AGENTS_MD_PROPOSAL,
    AGENTS_MD_PROPOSAL_META,
    AGENT_MD_PROPOSAL,
    AGENT_MD_PROPOSAL_META,
  ]) {
    const p = path.join(harnessDir, file);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}

export function wouldProposalShrinkExisting(existing: string, proposal: string): boolean {
  const outsideExisting = extractOutsideHarSection(existing);
  const outsideMerged = extractOutsideHarSection(mergeAgentsMdContent(existing, proposal));
  const existingLines = outsideExisting.split('\n').filter((l) => l.trim()).length;
  const mergedLines = outsideMerged.split('\n').filter((l) => l.trim()).length;
  return existingLines >= 5 && mergedLines < existingLines * 0.9;
}

/**
 * Merge a pending AGENTS.md.proposed into the live file (managed section only).
 * Returns true when a proposal was applied.
 */
export function applyAgentMdProposalMerge(
  repoPath: string,
  options: { rejectSignificantShrink?: boolean } = {},
): boolean {
  const proposal = readAgentMdProposal(repoPath);
  if (!proposal) return false;

  const agentsMdPath = path.join(repoPath, AGENTS_MD);
  if (fs.existsSync(agentsMdPath)) {
    const existing = fs.readFileSync(agentsMdPath, 'utf8');
    if (wouldProposalShrinkExisting(existing, proposal.content)) {
      const message =
        `${AGENTS_MD} proposal would drop project-specific content outside har:agent-environment markers — ` +
        `merge custom sections from .har/${AGENTS_MD_PROPOSAL} manually, then delete the proposal.`;
      if (options.rejectSignificantShrink) {
        throw new AgentsMdShrinkError(message);
      }
      warn(message);
      return false;
    }
    writeFileSafe(agentsMdPath, mergeAgentsMdContent(existing, proposal.content));
  } else {
    writeFileSafe(agentsMdPath, proposal.content);
  }

  clearAgentMdProposal(repoPath);
  info(`Merged ${AGENTS_MD} proposal into repo root (preserved content outside managed markers)`);
  return true;
}

/**
 * On finalize: merge any pending proposal, then refresh the managed HAR section.
 */
export function finalizeAgentsMdInstructionFiles(repoPath: string): void {
  applyAgentMdProposalMerge(repoPath, { rejectSignificantShrink: true });
  upsertAgentsMdHarSection(repoPath, { rejectSignificantShrink: true });
}

export async function promptApplyAgentMdProposal(repoPath: string): Promise<boolean> {
  const proposal = readAgentMdProposal(repoPath);
  if (!proposal) return false;

  const agentsMdPath = path.join(repoPath, AGENTS_MD);
  const exists = fs.existsSync(agentsMdPath);

  process.stderr.write('\n');
  process.stderr.write('────────────────────────────────────────────────────────────\n');
  process.stderr.write(`Proposed ${AGENTS_MD} (repo root)\n`);
  process.stderr.write('────────────────────────────────────────────────────────────\n');
  if (proposal.rationale) {
    process.stderr.write(`Why: ${proposal.rationale}\n\n`);
  }

  const preview = proposal.content.split('\n').slice(0, 40);
  for (const line of preview) {
    process.stderr.write(`  ${line}\n`);
  }
  if (proposal.content.split('\n').length > 40) {
    process.stderr.write('  ...\n');
  }
  process.stderr.write('\n');
  process.stderr.write(`Full proposal: .har/${AGENTS_MD_PROPOSAL}\n`);

  if (exists) {
    warn(`${AGENTS_MD} already exists at repo root.`);
    if (wouldProposalShrinkExisting(fs.readFileSync(agentsMdPath, 'utf8'), proposal.content)) {
      warn(
        'Proposal would drop project-specific content outside har:agent-environment markers — merge manually from the proposal file.',
      );
      return false;
    }
    const answer = await askYesNo(
      `Merge managed HAR section from this proposal into ${AGENTS_MD}? (y/n)`,
    );
    if (!answer) {
      info(`Skipped — proposal kept at .har/${AGENTS_MD_PROPOSAL}`);
      return false;
    }
  } else {
    const answer = await askYesNo(`Create ${AGENTS_MD} at repo root? (y/n)`);
    if (!answer) {
      info(`Skipped — proposal kept at .har/${AGENTS_MD_PROPOSAL}`);
      return false;
    }
  }

  applyAgentMdProposalMerge(repoPath);
  return true;
}

async function askYesNo(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    process.stderr.write(`${question} `);
    rl.once('line', (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}
