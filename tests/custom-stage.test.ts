import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scaffoldHarnessBoilerplate } from '../src/harness/generator';
import { addCustomStage } from '../src/harness/custom-stage';
import { readStageRegistry } from '../src/harness/stages';

function makeTempHarness(name: string): string {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  scaffoldHarnessBoilerplate(repoPath, { force: true, profile: 'cli' });
  return repoPath;
}

describe('addCustomStage', () => {
  it('registers a command stage and adds it to verificationStages', () => {
    const repoPath = makeTempHarness('har-custom-cmd');

    const result = addCustomStage(repoPath, {
      id: 'unit-tests-fast',
      kind: 'test',
      command: 'npm test -- --agent {agentId}',
      verification: true,
    });

    expect(result.mode).toBe('command');
    expect(result.filesWritten).toEqual(['.har/stages.json']);

    const registry = readStageRegistry(repoPath);
    expect(registry.stages.find((s) => s.id === 'unit-tests-fast')).toMatchObject({
      id: 'unit-tests-fast',
      kind: 'test',
      command: 'npm test -- --agent {agentId}',
    });
    expect(registry.verificationStages).toContain('unit-tests-fast');
    expect(registry.stages.find((s) => s.id === 'verify')?.description).toContain(
      'unit-tests-fast',
    );
  });

  it('scaffolds a contract-compliant script stage', () => {
    const repoPath = makeTempHarness('har-custom-script');

    const result = addCustomStage(repoPath, {
      id: 'db-integrity',
      script: true,
      description: 'Check database invariants',
    });

    expect(result.mode).toBe('script');
    const scriptPath = path.join(repoPath, '.har', 'stages', 'db-integrity.sh');
    expect(fs.existsSync(scriptPath)).toBe(true);
    expect(fs.statSync(scriptPath).mode & 0o111).not.toBe(0);

    const script = fs.readFileSync(scriptPath, 'utf8');
    expect(script).toContain('Check database invariants');
    expect(script).toContain('validate_agent_id');
    expect(script).toContain('artifacts/db-integrity');
    expect(script).not.toContain('__STAGE_ID__');
    expect(script).not.toContain('__STAGE_KIND__');

    const registry = readStageRegistry(repoPath);
    expect(registry.stages.find((s) => s.id === 'db-integrity')).toMatchObject({
      id: 'db-integrity',
      kind: 'custom',
      script: 'stages/db-integrity.sh',
    });
    expect(registry.verificationStages).not.toContain('db-integrity');
  });

  it('rejects invalid ids, kinds, and ambiguous modes', () => {
    const repoPath = makeTempHarness('har-custom-invalid');

    expect(() => addCustomStage(repoPath, { id: 'Bad Id', command: 'true' })).toThrow(/Invalid stage id/);
    expect(() =>
      addCustomStage(repoPath, { id: 'x', kind: 'nope' as never, command: 'true' }),
    ).toThrow(/Invalid stage kind/);
    expect(() => addCustomStage(repoPath, { id: 'x' })).toThrow(/exactly one execution mode/);
    expect(() => addCustomStage(repoPath, { id: 'x', command: 'true', script: true })).toThrow(
      /exactly one execution mode/,
    );
  });

  it('refuses to replace an existing stage without force', () => {
    const repoPath = makeTempHarness('har-custom-dup');
    addCustomStage(repoPath, { id: 'lint', command: 'npm run lint' });

    expect(() => addCustomStage(repoPath, { id: 'lint', command: 'npm run lint' })).toThrow(
      /already registered/,
    );

    addCustomStage(repoPath, { id: 'lint', command: 'npm run lint:ci', force: true });
    const registry = readStageRegistry(repoPath);
    expect(registry.stages.filter((s) => s.id === 'lint')).toHaveLength(1);
    expect(registry.stages.find((s) => s.id === 'lint')?.command).toBe('npm run lint:ci');
  });

  it('requires an existing harness', () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'har-custom-nohar-'));
    expect(() => addCustomStage(repoPath, { id: 'x', command: 'true' })).toThrow(/har env init/);
  });
});
