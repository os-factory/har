import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync, spawnSync } from 'child_process';
import { installHooks, uninstallHooks } from '../src/core/hooks';
import { produceValidationProof, runFactoryProofQuery } from '../src/core/proof';
import { recordValidation } from '../src/core/validations';
import { handleMcpToolCall } from '../src/mcp/server';

const FAKE_BIN = path.join(__dirname, 'fixtures', 'factory-commits', 'fake-git-factory');

function initRepo(): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'har-proof-cli-'));
  execSync('git init -q -b main', { cwd: dir });
  return dir;
}

function callArgv(log: string): string[][] {
  return fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line).argv);
}

describe('runFactoryProofQuery', () => {
  it('passes show/verify through with --json and returns the exit code', () => {
    const dir = initRepo();
    const log = path.join(dir, 'calls.jsonl');
    const env = { FAKE_GIT_FACTORY_LOG: log, FAKE_GIT_FACTORY_VERIFY_EXIT: '1', FAKE_GIT_FACTORY_LEVEL: 'L0' };

    const verify = runFactoryProofQuery({
      repoPath: dir,
      command: 'verify',
      rev: 'main~3..main',
      minLevel: 'L1',
      allowedSigners: 'signers',
      bin: FAKE_BIN,
      env,
    });
    expect(verify.code).toBe(1);
    expect(verify.result).toEqual({ commits: [{ commit: 'c'.repeat(40), level: 'L0', problems: [] }] });

    const show = runFactoryProofQuery({ repoPath: dir, command: 'show', bin: FAKE_BIN, env: { FAKE_GIT_FACTORY_LOG: log } });
    expect(show.code).toBe(0);
    expect(callArgv(log)).toEqual([
      ['verify', 'main~3..main', '--min-level', 'L1', '--allowed-signers', path.join(dir, 'signers'), '--json'],
      ['show', '--json'],
    ]);
  });

  it('reports unavailable (exit 2) when git-factory is missing, and rejects option-like revs', () => {
    const dir = initRepo();
    const missing = runFactoryProofQuery({ repoPath: dir, command: 'verify', env: { PATH: '/nonexistent' } });
    expect(missing).toMatchObject({ available: false, code: 2 });
    expect(missing.stderr).toContain('git-factory not found');

    const injected = runFactoryProofQuery({ repoPath: dir, command: 'show', rev: '--output=x', bin: FAKE_BIN });
    expect(injected.code).toBe(2);
  });
});

describe('MCP har_proof_show / har_proof_verify', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.HAR_FACTORY_PROOF_BIN;
    process.env.HAR_FACTORY_PROOF_BIN = FAKE_BIN;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.HAR_FACTORY_PROOF_BIN;
    else process.env.HAR_FACTORY_PROOF_BIN = saved;
  });

  it('returns the parsed git factory output and exit code', async () => {
    const dir = initRepo();
    const verify = await handleMcpToolCall('har_proof_verify', { repo: dir, minLevel: 'L1' });
    expect(verify.isError).toBeUndefined();
    expect(JSON.parse(verify.content[0].text)).toMatchObject({
      code: 0,
      available: true,
      result: { commits: [{ level: 'L1', problems: [] }] },
    });

    const show = await handleMcpToolCall('har_proof_show', { repo: dir, rev: 'HEAD' });
    expect(JSON.parse(show.content[0].text).result).toMatchObject({ note: null });
  });

  it('flags a missing binary as a tool error', async () => {
    process.env.HAR_FACTORY_PROOF_BIN = '/nonexistent/git-factory';
    const result = await handleMcpToolCall('har_proof_verify', { repo: initRepo() });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ code: 2, available: false });
  });
});

describe('har proof (built CLI)', () => {
  const cli = path.resolve(__dirname, '..', 'dist', 'index.js');
  const maybeIt = fs.existsSync(cli) ? it : it.skip;

  function har(dir: string, args: string[], env: NodeJS.ProcessEnv = {}) {
    return spawnSync(process.execPath, [cli, ...args], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, HAR_FACTORY_PROOF_BIN: FAKE_BIN, ...env },
    });
  }

  maybeIt('passes --json through verbatim and the exit code through', () => {
    const dir = initRepo();
    const ok = har(dir, ['proof', 'verify', '--json', '--repo', dir]);
    expect(ok.status).toBe(0);
    expect(JSON.parse(ok.stdout).commits[0].level).toBe('L1');

    const failed = har(dir, ['proof', 'verify', 'HEAD', '--min-level', 'L2', '--repo', dir], {
      FAKE_GIT_FACTORY_VERIFY_EXIT: '1',
    });
    expect(failed.status).toBe(1);
    expect(failed.stdout + failed.stderr).toContain('level L1');
  });

  maybeIt('exits 2 with a hint when git-factory is unavailable', () => {
    const dir = initRepo();
    const result = har(dir, ['proof', 'show', '--repo', dir], { HAR_FACTORY_PROOF_BIN: '/nonexistent/git-factory' });
    expect(result.status).toBe(2);
    expect(result.stdout + result.stderr).toContain('git-factory not found');
  });
});

// End-to-end against a real `git-factory` (factory-proof). Skipped unless
// HAR_FACTORY_PROOF_BIN points at one and the CLI is built.
const realBin = process.env.HAR_FACTORY_PROOF_BIN;
const builtCli = path.resolve(__dirname, '..', 'dist', 'index.js');
(realBin && fs.existsSync(builtCli) ? describe : describe.skip)('real git-factory end to end', () => {
  it('attests, writes trailers and the note on commit, and verifies at L1', () => {
    const dir = initRepo();
    const sh = (cmd: string) => execSync(cmd, { cwd: dir, encoding: 'utf8' }).trim();
    sh('git config user.email har@test.local');
    sh('git config user.name har');
    fs.mkdirSync(path.join(dir, '.har'));
    fs.writeFileSync(path.join(dir, '.har', '.gitignore'), 'runs/\nvalidations/\n');
    fs.writeFileSync(path.join(dir, '.har', 'harness.env'), 'HAR_FACTORY_PROOF=notes+trailers\n');
    fs.writeFileSync(
      path.join(dir, '.har', 'stages.json'),
      JSON.stringify({ version: '1', verificationStages: ['unit-tests'], stages: [{ id: 'unit-tests', kind: 'test', command: 'true' }] }),
    );
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
    sh('git add -A');
    sh('git commit -q -m init');
    const configBefore = sh('git config --local --list');

    installHooks({ repoPath: dir, harInvocation: `"${process.execPath}" "${builtCli}"` });
    expect(sh('git config notes.rewriteRef')).toBe('refs/notes/factory');

    fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
    const record = recordValidation({ checkoutDir: dir, harnessRoot: dir, status: 'pass', full: true });
    const produced = produceValidationProof({
      harnessRoot: dir,
      checkoutDir: dir,
      validation: record,
      verification: { status: 'pass', agent_id: 1, stages: [{ name: 'unit-tests', pass: true, ms: 3 }] },
    });
    expect(produced.outcome?.status).toBe('attested');
    sh('git add -A');
    sh('git commit -q -m "feat: two"');

    const body = sh('git log -1 --format=%B');
    expect(body).toContain(`Factory-Run: ${record.validationId}`);
    expect(body).toContain(`Factory-Attestation: ${produced.validation.attestationDigest}`);

    const verify = runFactoryProofQuery({ repoPath: dir, command: 'verify', minLevel: 'L1' });
    expect(verify.code).toBe(0);
    expect(verify.result).toMatchObject({ commits: [{ level: 'L1', problems: [] }] });

    const show = runFactoryProofQuery({ repoPath: dir, command: 'show' });
    expect(show.code).toBe(0);

    uninstallHooks(dir);
    expect(sh('git config --local --list')).toBe(configBefore);
  });
});
