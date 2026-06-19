import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { writeFileSafe } from '../utils/file-ops';
import { info, warn } from '../utils/logging';
import { getHarnessDir } from './manifest';

export const AGENT_MD_PROPOSAL = 'AGENT.md.proposed';
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
  writeFileSafe(path.join(harnessDir, AGENT_MD_PROPOSAL), content);
  writeFileSafe(
    path.join(harnessDir, AGENT_MD_PROPOSAL_META),
    JSON.stringify({ rationale, createdAt: new Date().toISOString() }, null, 2) + '\n',
  );
}

export function readAgentMdProposal(repoPath: string): AgentMdProposal | null {
  const harnessDir = getHarnessDir(repoPath);
  const proposalPath = path.join(harnessDir, AGENT_MD_PROPOSAL);
  const metaPath = path.join(harnessDir, AGENT_MD_PROPOSAL_META);

  if (!fs.existsSync(proposalPath)) return null;

  const content = fs.readFileSync(proposalPath, 'utf8');
  let rationale = '';
  if (fs.existsSync(metaPath)) {
    try {
      rationale = JSON.parse(fs.readFileSync(metaPath, 'utf8')).rationale ?? '';
    } catch {
      rationale = '';
    }
  }

  return {
    content,
    rationale,
    createdAt: fs.existsSync(metaPath)
      ? JSON.parse(fs.readFileSync(metaPath, 'utf8')).createdAt
      : new Date().toISOString(),
  };
}

export function clearAgentMdProposal(repoPath: string): void {
  const harnessDir = getHarnessDir(repoPath);
  for (const file of [AGENT_MD_PROPOSAL, AGENT_MD_PROPOSAL_META]) {
    const p = path.join(harnessDir, file);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}

export async function promptApplyAgentMdProposal(repoPath: string): Promise<boolean> {
  const proposal = readAgentMdProposal(repoPath);
  if (!proposal) return false;

  const agentMdPath = path.join(repoPath, 'AGENT.md');
  const exists = fs.existsSync(agentMdPath);

  process.stderr.write('\n');
  process.stderr.write('────────────────────────────────────────────────────────────\n');
  process.stderr.write('Proposed AGENT.md (repo root)\n');
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
  process.stderr.write(`Full proposal: .har/${AGENT_MD_PROPOSAL}\n`);

  if (exists) {
    warn('AGENT.md already exists at repo root.');
    const answer = await askYesNo('Replace AGENT.md with this proposal? (y/n)');
    if (!answer) {
      info('Skipped — proposal kept at .har/AGENT.md.proposed');
      return false;
    }
  } else {
    const answer = await askYesNo('Create AGENT.md at repo root? (y/n)');
    if (!answer) {
      info('Skipped — proposal kept at .har/AGENT.md.proposed');
      return false;
    }
  }

  writeFileSafe(agentMdPath, proposal.content);
  clearAgentMdProposal(repoPath);
  info('Wrote AGENT.md');
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
