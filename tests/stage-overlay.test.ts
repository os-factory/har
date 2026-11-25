import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scaffoldHarnessBoilerplate } from '../src/harness/generator';
import { applyLine } from '../src/harness/lines';
import { applyPlugin } from '../src/harness/plugins';
import { runDoctor } from '../src/harness/doctor';
import {
  applyAgentSlotMax,
  getVerificationStageIds,
  readCommittedStageRegistry,
  readStageOverlay,
  readStageRegistry,
  writeStageOverlay,
  writeStageRegistry,
} from '../src/harness/stages';
import { ensureEcosystemVerificationStages } from '../src/harness/verification';
import { runStage } from '../src/core/run-service';
import type { HarnessStage } from '../src/harness/schema';

function makeTempRepo(name: string): string {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  fs.writeFileSync(
    path.join(repoPath, 'package.json'),
    JSON.stringify({ name: 'test-app', version: '1.0.0' }, null, 2) + '\n',
  );
  scaffoldHarnessBoilerplate(repoPath, { force: true, profile: 'cli' });
  return repoPath;
}

const registryPath = (repoPath: string): string => path.join(repoPath, '.har', 'stages.json');
const overlayPath = (repoPath: string): string => path.join(repoPath, '.har', 'local', 'stages.json');

/** A slotless overlay stage with a real script under .har/local/stages/. */
function addOverlayStage(repoPath: string, id: string, extra: Partial<HarnessStage> = {}): void {
  const script = path.join(repoPath, '.har', 'local', 'stages', `${id}.sh`);
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(
    script,
    `#!/usr/bin/env bash\necho "overlay ${id}" > "${path.join(repoPath, `ran-${id}.txt`)}"\n`,
    { mode: 0o755 },
  );
  const overlay = readStageOverlay(repoPath) ?? { version: '1', stages: [] };
  writeStageOverlay(repoPath, {
    ...overlay,
    stages: [
      ...overlay.stages,
      { id, kind: 'test', script: `local/stages/${id}.sh`, requiresAgentId: false, ...extra } as HarnessStage,
    ],
  });
}

describe('personal stage overlay (.har/local/stages.json)', () => {
  it('a personal line install leaves stages.json byte-identical and registers into the overlay', () => {
    const repoPath = makeTempRepo('har-overlay-install');
    const before = fs.readFileSync(registryPath(repoPath));

    applyLine(repoPath, 'example-line', { scope: 'personal' });

    expect(fs.readFileSync(registryPath(repoPath)).equals(before)).toBe(true);
    expect(readStageOverlay(repoPath)?.stages.map((s) => s.id)).toEqual(['example-gate']);
    // Readers see it; the committed registry does not.
    expect(readStageRegistry(repoPath).stages.some((s) => s.id === 'example-gate')).toBe(true);
    expect(readCommittedStageRegistry(repoPath).stages.some((s) => s.id === 'example-gate')).toBe(false);
  });

  it('runs an overlay stage through run-stage', async () => {
    const repoPath = makeTempRepo('har-overlay-run');
    addOverlayStage(repoPath, 'mine');

    const result = await runStage({ repoPath, stageId: 'mine', capture: true, trigger: 'cli' });
    expect(result.status).toBe('pass');
    expect(fs.readFileSync(path.join(repoPath, 'ran-mine.txt'), 'utf8')).toContain('overlay mine');
  });

  it('never puts overlay stages on the verify plan', () => {
    const repoPath = makeTempRepo('har-overlay-verify');
    const verifyBefore = getVerificationStageIds(repoPath);
    addOverlayStage(repoPath, 'mine', { group: 'verification', tier: 'quick' } as Partial<HarnessStage>);

    expect(getVerificationStageIds(repoPath)).toEqual(verifyBefore);
    expect(getVerificationStageIds(repoPath)).not.toContain('mine');
    // The verify runner reads the committed file directly — it has no overlay stage.
    const committed = JSON.parse(fs.readFileSync(registryPath(repoPath), 'utf8'));
    expect(committed.stages.map((s: { id: string }) => s.id)).not.toContain('mine');
  });

  it('rejects an overlay that tries to set verificationStages or other settings', () => {
    const repoPath = makeTempRepo('har-overlay-strict');
    fs.mkdirSync(path.dirname(overlayPath(repoPath)), { recursive: true });
    fs.writeFileSync(
      overlayPath(repoPath),
      JSON.stringify({ version: '1', stages: [], verificationStages: ['mine'] }),
    );

    expect(() => readStageOverlay(repoPath)).toThrow(/only "version" and "stages"/);
    expect(runDoctor(repoPath).findings).toContainEqual(
      expect.objectContaining({ check: 'stages-registry', severity: 'error', file: 'local/stages.json' }),
    );
  });

  it('treats an id in both files as an error, never an override', () => {
    const repoPath = makeTempRepo('har-overlay-clash');
    const committedId = readCommittedStageRegistry(repoPath).stages[0].id;
    // Hand-made clash: written directly, bypassing the install guards.
    fs.mkdirSync(path.dirname(overlayPath(repoPath)), { recursive: true });
    fs.writeFileSync(
      overlayPath(repoPath),
      JSON.stringify({ version: '1', stages: [{ id: committedId, kind: 'test', command: 'true' }] }),
    );

    expect(() => readStageRegistry(repoPath)).toThrow(/registered in both/);
    const doctor = runDoctor(repoPath);
    expect(doctor.ok).toBe(false);
    expect(doctor.findings).toContainEqual(
      expect.objectContaining({
        check: 'stages-registry',
        severity: 'error',
        message: expect.stringMatching(/registered in both/),
      }),
    );
  });

  it('reports a personal stage listed in verificationStages', () => {
    const repoPath = makeTempRepo('har-overlay-verify-leak');
    addOverlayStage(repoPath, 'mine');
    const committed = readCommittedStageRegistry(repoPath);
    fs.writeFileSync(
      registryPath(repoPath),
      JSON.stringify({ ...committed, verificationStages: [...(committed.verificationStages ?? []), 'mine'] }, null, 2),
    );

    expect(runDoctor(repoPath).findings).toContainEqual(
      expect.objectContaining({ check: 'factory-lines', severity: 'error', message: expect.stringMatching(/personal stage/) }),
    );
  });

  it('committed-registry writers never pull overlay stages into stages.json', () => {
    const repoPath = makeTempRepo('har-overlay-writers');
    addOverlayStage(repoPath, 'mine');

    applyPlugin(repoPath, 'playwright', { skipCi: true });
    applyAgentSlotMax(repoPath, 4);
    ensureEcosystemVerificationStages(repoPath);

    const committed = JSON.parse(fs.readFileSync(registryPath(repoPath), 'utf8'));
    expect(committed.stages.map((s: { id: string }) => s.id)).not.toContain('mine');
    expect(committed.stages.map((s: { id: string }) => s.id)).toContain('browser-e2e');
    expect(readStageOverlay(repoPath)?.stages.map((s) => s.id)).toEqual(['mine']);
  });

  it('writeStageRegistry refuses to write an overlay stage into the committed file', () => {
    const repoPath = makeTempRepo('har-overlay-guard');
    addOverlayStage(repoPath, 'mine');
    const merged = readStageRegistry(repoPath);

    expect(() => writeStageRegistry(repoPath, merged)).toThrow(/belong to the personal overlay/);
  });

  it('refuses a team stage id that a personal line already registered', () => {
    const repoPath = makeTempRepo('har-overlay-team-clash');
    addOverlayStage(repoPath, 'example-gate');

    expect(() => applyLine(repoPath, 'example-line')).toThrow(/registered by a personal line/);
    expect(readCommittedStageRegistry(repoPath).stages.some((s) => s.id === 'example-gate')).toBe(false);
  });

  it('moves a personal stage left in stages.json by an older install into the overlay', () => {
    const repoPath = makeTempRepo('har-overlay-legacy');
    applyLine(repoPath, 'example-line', { scope: 'personal' });
    // Simulate the pre-overlay install: the stage sat in the committed registry.
    const overlay = readStageOverlay(repoPath)!;
    writeStageOverlay(repoPath, { ...overlay, stages: [] });
    const committed = readCommittedStageRegistry(repoPath);
    writeStageRegistry(repoPath, { ...committed, stages: [...committed.stages, ...overlay.stages] });

    expect(runDoctor(repoPath).findings).toContainEqual(
      expect.objectContaining({ check: 'factory-lines', severity: 'warning', message: expect.stringMatching(/gitignored personal script/) }),
    );

    applyLine(repoPath, 'example-line', { scope: 'personal', force: true });

    expect(readCommittedStageRegistry(repoPath).stages.some((s) => s.id === 'example-gate')).toBe(false);
    expect(readStageOverlay(repoPath)?.stages.map((s) => s.id)).toEqual(['example-gate']);
    expect(fs.existsSync(overlayPath(repoPath))).toBe(true);
  });
});
