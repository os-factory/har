import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as instructionFiles from '../src/harness/instruction-files';
import {
  AGENTS_MD,
  AgentsMdShrinkError,
  HAR_SECTION_END,
  HAR_SECTION_START,
  checkOutsideContentPreserved,
  upsertAgentsMdHarSection,
} from '../src/harness/instruction-files';
import {
  applyAgentMdProposalMerge,
  wouldProposalShrinkExisting,
  writeAgentMdProposal,
} from '../src/harness/agent-md';

function makeTempRepo(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  fs.mkdirSync(path.join(dir, '.har'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: prefix }) + '\n');
  return dir;
}

function outsideLines(count: number, prefix = 'line'): string {
  return Array.from({ length: count }, (_, i) => `${prefix} ${i}`).join('\n');
}

describe('checkOutsideContentPreserved', () => {
  it('detects shrink when outside-marker lines drop below 90%', () => {
    const before = `# Project\n\n${outsideLines(10)}\n\n${HAR_SECTION_START}\nold\n${HAR_SECTION_END}\n`;
    const after = `# Project\n\n${outsideLines(8)}\n\n${HAR_SECTION_START}\nnew\n${HAR_SECTION_END}\n`;

    expect(checkOutsideContentPreserved(before, after, {})).toBe('shrink');
  });

  it('allows changes that preserve at least 90% of outside-marker lines', () => {
    const before = `# Project\n\n${outsideLines(10)}\n\n${HAR_SECTION_START}\nold\n${HAR_SECTION_END}\n`;
    const after = `# Project\n\n${outsideLines(9)}\n\n${HAR_SECTION_START}\nnew\n${HAR_SECTION_END}\n`;

    expect(checkOutsideContentPreserved(before, after, {})).toBe('ok');
  });

  it('does not apply ratio guard when fewer than five outside-marker lines exist', () => {
    const before = `# Small\n\n${outsideLines(3)}\n\n${HAR_SECTION_START}\nold\n${HAR_SECTION_END}\n`;
    const after = `# Small\n\none\n\n${HAR_SECTION_START}\nnew\n${HAR_SECTION_END}\n`;

    expect(checkOutsideContentPreserved(before, after, {})).toBe('ok');
  });
});

describe('wouldProposalShrinkExisting', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns true when merged content would drop outside-marker lines', () => {
    const existing = `# Project\n\n${outsideLines(10, 'keep')}\n\n${HAR_SECTION_START}\nold\n${HAR_SECTION_END}\n`;
    const proposal = `# Proposed\n\n${HAR_SECTION_START}\nnew\n${HAR_SECTION_END}\n`;
    const shrunk = `# Project\n\n${outsideLines(8, 'keep')}\n\n${HAR_SECTION_START}\nnew\n${HAR_SECTION_END}\n`;

    jest.spyOn(instructionFiles, 'mergeAgentsMdContent').mockReturnValue(shrunk);

    expect(wouldProposalShrinkExisting(existing, proposal)).toBe(true);
  });

  it('returns false when merge preserves outside-marker content', () => {
    const existing = `# Project\n\n${outsideLines(10, 'keep')}\n\n${HAR_SECTION_START}\nold\n${HAR_SECTION_END}\n`;
    const proposal = `# Proposed\n\n${HAR_SECTION_START}\nnew\n${HAR_SECTION_END}\n`;

    expect(wouldProposalShrinkExisting(existing, proposal)).toBe(false);
  });
});

describe('AGENTS.md shrink guard integration', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('allows refresh when outside-marker content is preserved', () => {
    const repoPath = makeTempRepo('har-shrink-ok');
    fs.writeFileSync(
      path.join(repoPath, AGENTS_MD),
      `# Project\n\n${outsideLines(10)}\n\n${HAR_SECTION_START}\nold har\n${HAR_SECTION_END}\n`,
    );

    expect(() =>
      upsertAgentsMdHarSection(repoPath, { rejectSignificantShrink: true }),
    ).not.toThrow();

    const content = fs.readFileSync(path.join(repoPath, AGENTS_MD), 'utf8');
    expect(content).toContain('line 0');
    expect(content).toContain('Launch first');
  });

  it('rejects AGENTS.md.proposed merge that would drop outside-marker content', () => {
    const repoPath = makeTempRepo('har-proposal-shrink');
    const existing = `# Project\n\n${outsideLines(10, 'keep')}\n\n${HAR_SECTION_START}\nold har\n${HAR_SECTION_END}\n`;
    fs.writeFileSync(path.join(repoPath, AGENTS_MD), existing);
    writeAgentMdProposal(
      repoPath,
      `# Proposed\n\n${HAR_SECTION_START}\nnew har\n${HAR_SECTION_END}\n`,
      'refresh managed section',
    );

    jest.spyOn(instructionFiles, 'mergeAgentsMdContent').mockReturnValue(
      `# Project\n\n${outsideLines(8, 'keep')}\n\n${HAR_SECTION_START}\nnew har\n${HAR_SECTION_END}\n`,
    );

    expect(() =>
      applyAgentMdProposalMerge(repoPath, { rejectSignificantShrink: true }),
    ).toThrow(AgentsMdShrinkError);
    expect(fs.existsSync(path.join(repoPath, '.har', 'AGENTS.md.proposed'))).toBe(true);
  });

  it('merges AGENTS.md.proposed when outside-marker content is preserved', () => {
    const repoPath = makeTempRepo('har-proposal-ok');
    fs.writeFileSync(
      path.join(repoPath, AGENTS_MD),
      `# Project\n\n${outsideLines(10, 'keep')}\n\n${HAR_SECTION_START}\nold har\n${HAR_SECTION_END}\n`,
    );
    writeAgentMdProposal(
      repoPath,
      `# Proposed\n\n${HAR_SECTION_START}\nnew har\n${HAR_SECTION_END}\n`,
      'refresh managed section',
    );

    expect(applyAgentMdProposalMerge(repoPath, { rejectSignificantShrink: true })).toBe(true);

    const content = fs.readFileSync(path.join(repoPath, AGENTS_MD), 'utf8');
    expect(content).toContain('keep 0');
    expect(content).toContain('new har');
    expect(fs.existsSync(path.join(repoPath, '.har', 'AGENTS.md.proposed'))).toBe(false);
  });
});
