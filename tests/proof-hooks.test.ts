import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import {
  getHooksStatus,
  installHooks,
  recordCommitAssociation,
  recordCommitTrailers,
  resolveHooksDir,
  uninstallHooks,
} from '../src/core/hooks';
import { produceValidationProof } from '../src/core/proof';
import { recordValidation } from '../src/core/validations';
import { bindValidationToAttempt, upsertWorkUnit } from '../src/core/work-units';
import { VerificationResult } from '../src/harness/schema';

const FAKE_BIN = path.join(__dirname, 'fixtures', 'factory-commits', 'fake-git-factory');

const STAGES = {
  version: '1',
  verificationStages: ['unit-tests'],
  stages: [{ id: 'unit-tests', kind: 'test', command: 'true' }],
};
const PASSING: VerificationResult = {
  status: 'pass',
  agent_id: 1,
  stages: [{ name: 'unit-tests', pass: true, ms: 5 }],
};

function sh(cwd: string, command: string, env: NodeJS.ProcessEnv = {}): string {
  return execSync(command, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  }).trim();
}

function initRepo(harnessEnv?: string): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'har-proof-hooks-'));
  sh(dir, 'git init -q -b main');
  sh(dir, 'git config user.email har@test.local');
  sh(dir, 'git config user.name har');
  sh(dir, 'git remote add origin https://example.invalid/acme/app.git');
  fs.mkdirSync(path.join(dir, '.har'));
  fs.writeFileSync(path.join(dir, '.har', '.gitignore'), 'runs/\nvalidations/\nwork-units/\nwork-attempts/\nvalidation-bindings/\n');
  fs.writeFileSync(path.join(dir, '.har', 'stages.json'), JSON.stringify(STAGES));
  if (harnessEnv !== undefined) fs.writeFileSync(path.join(dir, '.har', 'harness.env'), harnessEnv);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
  sh(dir, 'git add -A');
  sh(dir, 'git commit -q -m init');
  return dir;
}

function snapshotHooks(dir: string): Record<string, string> {
  const hooksDir = resolveHooksDir(dir);
  const out: Record<string, string> = {};
  for (const name of fs.readdirSync(hooksDir).sort()) {
    if (name.endsWith('.sample')) continue;
    out[name] = fs.readFileSync(path.join(hooksDir, name), 'utf8');
  }
  return out;
}

function localConfig(dir: string): string {
  return sh(dir, 'git config --local --list');
}

function logLines(log: string): Array<{ argv: string[] }> {
  if (!fs.existsSync(log)) return [];
  return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

let savedBin: string | undefined;
let savedLog: string | undefined;
let log: string;

beforeEach(() => {
  savedBin = process.env.HAR_FACTORY_PROOF_BIN;
  savedLog = process.env.FAKE_GIT_FACTORY_LOG;
  log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'har-proof-log-')), 'calls.jsonl');
  process.env.HAR_FACTORY_PROOF_BIN = FAKE_BIN;
  process.env.FAKE_GIT_FACTORY_LOG = log;
});

afterEach(() => {
  if (savedBin === undefined) delete process.env.HAR_FACTORY_PROOF_BIN;
  else process.env.HAR_FACTORY_PROOF_BIN = savedBin;
  if (savedLog === undefined) delete process.env.FAKE_GIT_FACTORY_LOG;
  else process.env.FAKE_GIT_FACTORY_LOG = savedLog;
  delete process.env.FAKE_GIT_FACTORY_EXIT;
});

describe('har hooks with HAR_FACTORY_PROOF=off, and with it unset (2.0 default)', () => {
  it('installs exactly the same hook files and never touches git config or git-factory', () => {
    const baseline = initRepo();
    const optedOut = initRepo('HARNESS_PROJECT_NAME=x\nHAR_FACTORY_PROOF=off\n');
    const configBefore = localConfig(optedOut);

    const baseResult = installHooks({ repoPath: baseline, harInvocation: 'har' });
    const result = installHooks({ repoPath: optedOut, harInvocation: 'har' });

    expect(result).toEqual({ ...baseResult, hooksDir: resolveHooksDir(optedOut) });
    expect(result.commitMsg).toBeUndefined();
    expect(result.factoryProof).toBeUndefined();
    expect(snapshotHooks(optedOut)).toEqual(snapshotHooks(baseline));
    expect(Object.keys(snapshotHooks(optedOut))).toEqual([
      'har-post-commit',
      'har-pre-commit',
      'post-commit',
      'pre-commit',
    ]);
    expect(localConfig(optedOut)).toBe(configBefore);
    expect(getHooksStatus(optedOut)).toMatchObject({ commitMsgInstalled: false, factoryProofMode: 'off' });

    const removed = uninstallHooks(optedOut);
    expect(removed.factoryProof).toBeUndefined();
    expect(snapshotHooks(optedOut)).toEqual({});
    expect(localConfig(optedOut)).toBe(configBefore);
    expect(logLines(log)).toEqual([]);
  });

  it('records commits without calling git-factory', async () => {
    const dir = initRepo();
    recordValidation({ checkoutDir: dir, harnessRoot: dir, status: 'pass', full: true });
    sh(dir, 'git commit -q --allow-empty -m next');
    const result = await recordCommitAssociation(dir);
    expect(result.proof).toBeUndefined();
    expect(logLines(log)).toEqual([]);
  });
});

describe('har hooks install / uninstall with proofs opted in', () => {
  it('notes: runs git factory setup once and undoes it on uninstall, no commit-msg hook', () => {
    const dir = initRepo('HAR_FACTORY_PROOF=notes\n');
    const configBefore = localConfig(dir);

    const result = installHooks({ repoPath: dir, harInvocation: 'har' });
    expect(result.factoryProof?.mode).toBe('notes');
    expect(result.factoryProof?.setup?.status).toBe('attested');
    expect(result.commitMsg).toBeUndefined();
    expect(sh(dir, 'git config notes.rewriteRef')).toBe('refs/notes/factory');
    installHooks({ repoPath: dir, harInvocation: 'har' });
    expect(sh(dir, 'git config --get-all remote.origin.fetch').split('\n')).toEqual([
      '+refs/heads/*:refs/remotes/origin/*',
      '+refs/notes/factory:refs/notes/factory',
    ]);
    expect(fs.existsSync(path.join(resolveHooksDir(dir), 'commit-msg'))).toBe(false);

    const removed = uninstallHooks(dir);
    expect(removed.factoryProof?.setup?.status).toBe('attested');
    expect(localConfig(dir)).toBe(configBefore);
    expect(logLines(log).map((l) => l.argv)).toEqual([['setup'], ['setup'], ['setup', '--undo']]);
  });

  it('notes+trailers: installs a managed commit-msg block, reports it, and removes it', () => {
    const dir = initRepo('HAR_FACTORY_PROOF=notes+trailers\n');
    const hooksDir = resolveHooksDir(dir);
    fs.writeFileSync(path.join(hooksDir, 'commit-msg'), '#!/bin/sh\necho existing-hook\n', { mode: 0o755 });

    const result = installHooks({ repoPath: dir, harInvocation: 'har' });
    expect(result.commitMsg).toBe('appended');
    const commitMsg = fs.readFileSync(path.join(hooksDir, 'commit-msg'), 'utf8');
    expect(commitMsg).toContain('echo existing-hook');
    expect(commitMsg).toContain('har-commit-msg" "$1" || true');
    expect(fs.readFileSync(path.join(hooksDir, 'har-commit-msg'), 'utf8')).toContain('hooks commit-msg "$1"');
    expect(getHooksStatus(dir)).toMatchObject({ commitMsgInstalled: true, factoryProofMode: 'notes+trailers' });

    uninstallHooks(dir);
    expect(fs.readFileSync(path.join(hooksDir, 'commit-msg'), 'utf8')).not.toContain('har commit gate');
    expect(fs.existsSync(path.join(hooksDir, 'har-commit-msg'))).toBe(false);
    expect(getHooksStatus(dir).commitMsgInstalled).toBe(false);
  });

  it('fails open when git-factory is missing', () => {
    const dir = initRepo('HAR_FACTORY_PROOF=notes\n');
    process.env.HAR_FACTORY_PROOF_BIN = '/nonexistent/git-factory';
    const result = installHooks({ repoPath: dir, harInvocation: 'har' });
    expect(result.factoryProof?.setup?.status).toBe('skipped');
    expect(getHooksStatus(dir).preCommitInstalled).toBe(true);
  });
});

function attestedValidation(dir: string) {
  const record = recordValidation({ checkoutDir: dir, harnessRoot: dir, status: 'pass', full: true });
  const produced = produceValidationProof({ harnessRoot: dir, checkoutDir: dir, validation: record, verification: PASSING });
  expect(produced.outcome?.status).toBe('attested');
  return produced.validation;
}

describe('post-commit factory note', () => {
  it('adds the attestation to the note on HEAD when the tree was verified', async () => {
    const dir = initRepo('HAR_FACTORY_PROOF=notes\n');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');
    const validation = attestedValidation(dir);
    sh(dir, 'git add -A');
    sh(dir, 'git commit -q -m change');

    const result = await recordCommitAssociation(dir);
    expect(result.attached).toBe(true);
    expect(result.proof?.status).toBe('attested');
    const note = JSON.parse(sh(dir, 'git notes --ref refs/notes/factory show HEAD'));
    expect(note.attestations.map((a: { digest: string }) => a.digest)).toEqual([validation.attestationDigest]);
  });

  it('does nothing for a tree without an attested passing validation', async () => {
    const dir = initRepo('HAR_FACTORY_PROOF=notes\n');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');
    sh(dir, 'git add -A');
    sh(dir, 'git commit -q -m change');
    const result = await recordCommitAssociation(dir);
    expect(result.proof).toBeUndefined();
    expect(logLines(log)).toEqual([]);
  });

  it('fails open when git factory note add exits 2', async () => {
    const dir = initRepo('HAR_FACTORY_PROOF=notes\n');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');
    attestedValidation(dir);
    sh(dir, 'git add -A');
    sh(dir, 'git commit -q -m change');
    process.env.FAKE_GIT_FACTORY_EXIT = '2';

    const result = await recordCommitAssociation(dir);
    expect(result.attached).toBe(true);
    expect(result.proof?.status).toBe('failed');
    expect(result.proof?.message).toContain('exited 2');
  });
});

describe('commit-msg factory trailers', () => {
  function messageFile(): string {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'har-msg-')), 'COMMIT_EDITMSG');
    fs.writeFileSync(file, 'feat: change\n');
    return file;
  }

  it('adds Work-Unit, Factory-Run and Factory-Attestation for the staged tree', () => {
    const dir = initRepo('HAR_FACTORY_PROOF=notes+trailers\n');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');
    const validation = attestedValidation(dir);
    upsertWorkUnit(dir, { workUnitId: 'FE-1', source: 'linear', title: 'Secret title' });
    bindValidationToAttempt(dir, {
      workUnitId: 'FE-1',
      attemptId: '00000000-0000-4000-8000-000000000001',
      validation,
    });
    sh(dir, 'git add -A');
    const file = messageFile();

    const outcome = recordCommitTrailers(dir, file);
    expect(outcome?.status).toBe('attested');
    const call = logLines(log).find((l) => l.argv[0] === 'trailers');
    expect(call?.argv).toEqual([
      'trailers',
      file,
      '--work-unit',
      'linear:FE-1',
      '--run',
      validation.validationId,
      '--attestation',
      validation.attestationDigest,
    ]);
    const message = fs.readFileSync(file, 'utf8');
    expect(message).toContain(`Factory-Run: ${validation.validationId}`);
    expect(message).not.toContain('Secret title');
  });

  it('is a no-op in notes mode and for unverified trees', () => {
    const notesOnly = initRepo('HAR_FACTORY_PROOF=notes\n');
    fs.writeFileSync(path.join(notesOnly, 'a.txt'), 'changed\n');
    attestedValidation(notesOnly);
    sh(notesOnly, 'git add -A');
    expect(recordCommitTrailers(notesOnly, messageFile())).toBeUndefined();

    const unverified = initRepo('HAR_FACTORY_PROOF=notes+trailers\n');
    fs.writeFileSync(path.join(unverified, 'a.txt'), 'changed\n');
    sh(unverified, 'git add -A');
    expect(recordCommitTrailers(unverified, messageFile())).toBeUndefined();
    expect(logLines(log).filter((l) => l.argv[0] === 'trailers')).toEqual([]);
  });

  it('never throws when git factory trailers fails', () => {
    const dir = initRepo('HAR_FACTORY_PROOF=notes+trailers\n');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');
    attestedValidation(dir);
    sh(dir, 'git add -A');
    process.env.FAKE_GIT_FACTORY_EXIT = '2';
    const file = messageFile();
    expect(recordCommitTrailers(dir, file)?.status).toBe('failed');
    expect(fs.readFileSync(file, 'utf8')).toBe('feat: change\n');
  });
});

describe('end-to-end git commit with factory proofs (built CLI)', () => {
  const cli = path.resolve(__dirname, '..', 'dist', 'index.js');
  const maybeIt = fs.existsSync(cli) ? it : it.skip;

  maybeIt('writes trailers in commit-msg and the note in post-commit; a failing git-factory never blocks', () => {
    const dir = initRepo('HAR_FACTORY_PROOF=notes+trailers\n');
    installHooks({ repoPath: dir, harInvocation: `"${process.execPath}" "${cli}"` });
    fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');
    const validation = attestedValidation(dir);
    sh(dir, 'git add -A');
    sh(dir, 'git commit -q -m "feat: change"');

    expect(sh(dir, 'git log -1 --format=%B')).toContain(`Factory-Run: ${validation.validationId}`);
    expect(sh(dir, 'git log -1 --format=%B')).toContain(`Factory-Attestation: ${validation.attestationDigest}`);
    const note = JSON.parse(sh(dir, 'git notes --ref refs/notes/factory show HEAD'));
    expect(note.attestations[0].digest).toBe(validation.attestationDigest);

    fs.writeFileSync(path.join(dir, 'a.txt'), 'changed again\n');
    attestedValidation(dir);
    sh(dir, 'git add -A');
    sh(dir, 'git commit -q -m "fix: again"', { FAKE_GIT_FACTORY_EXIT: '2' });
    expect(sh(dir, 'git log -1 --format=%s')).toBe('fix: again');
  });
});

describe('HAR 2.0 default proof mode (HAR_FACTORY_PROOF unset)', () => {
  it('hooks install and uninstall never change git config or call git-factory', () => {
    const dir = initRepo('HARNESS_PROJECT_NAME=x\n');
    const configBefore = localConfig(dir);

    const result = installHooks({ repoPath: dir, harInvocation: 'har' });
    expect(result.factoryProof).toBeUndefined();
    expect(result.commitMsg).toBeUndefined();
    expect(localConfig(dir)).toBe(configBefore);
    expect(getHooksStatus(dir)).toMatchObject({
      commitMsgInstalled: false,
      factoryProofMode: 'notes',
      factoryProofModeSource: 'default',
    });

    expect(uninstallHooks(dir).factoryProof).toBeUndefined();
    expect(localConfig(dir)).toBe(configBefore);
    expect(logLines(log)).toEqual([]);
  });

  it('writes the local note on commit when git-factory is installed', async () => {
    const dir = initRepo();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');
    const validation = attestedValidation(dir);
    sh(dir, 'git add -A');
    sh(dir, 'git commit -q -m change');

    const result = await recordCommitAssociation(dir);
    expect(result.proof?.status).toBe('attested');
    const note = JSON.parse(sh(dir, 'git notes --ref refs/notes/factory show HEAD'));
    expect(note.attestations.map((a: { digest: string }) => a.digest)).toEqual([validation.attestationDigest]);
    expect(logLines(log).map((l) => l.argv[0])).toEqual(['attest', 'note']);
  });

  it('is silent on commit when git-factory disappears, but hints under an explicit opt-in', async () => {
    for (const [harnessEnv, expectHint] of [[undefined, false], ['HAR_FACTORY_PROOF=notes\n', true]] as const) {
      process.env.HAR_FACTORY_PROOF_BIN = FAKE_BIN;
      const dir = initRepo(harnessEnv);
      fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');
      attestedValidation(dir);
      sh(dir, 'git add -A');
      sh(dir, 'git commit -q -m change');
      process.env.HAR_FACTORY_PROOF_BIN = '/nonexistent/git-factory';

      const result = await recordCommitAssociation(dir);
      expect(result.attached).toBe(true);
      if (expectHint) {
        expect(result.proof?.status).toBe('skipped');
        expect(result.proof?.message).toContain('git-factory not found');
      } else {
        expect(result.proof).toBeUndefined();
      }
    }
  });
});
