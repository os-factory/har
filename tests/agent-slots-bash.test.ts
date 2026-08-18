import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const AGENT_SLOT = path.join(process.cwd(), 'src/templates/har-boilerplate/agent-slot.sh');

describe('bash agent slot limits', () => {
  it('reads agentSlots from stages.json before harness.env', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-bash-slots-'));
    const harDir = path.join(dir, '.har');
    fs.mkdirSync(harDir, { recursive: true });
    fs.writeFileSync(
      path.join(harDir, 'stages.json'),
      JSON.stringify({ version: '1', agentSlots: { min: 1, max: 10 }, stages: [] }),
    );
    fs.writeFileSync(
      path.join(harDir, 'harness.env'),
      ['export HARNESS_AGENT_SLOT_MIN=1', 'export HARNESS_AGENT_SLOT_MAX=3', ''].join('\n'),
    );

    const ok = execSync(
      `bash -c 'SCRIPT_DIR="${harDir}"; source "${harDir}/harness.env"; source "${AGENT_SLOT}"; validate_agent_id 10'`,
      { encoding: 'utf8' },
    );
    expect(ok).toBe('');

    let failed = false;
    try {
      execSync(
        `bash -c 'SCRIPT_DIR="${harDir}"; source "${harDir}/harness.env"; source "${AGENT_SLOT}"; validate_agent_id 11'`,
        { encoding: 'utf8', stdio: 'pipe' },
      );
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });

  it('har_suggest_launch prefers MCP/CLI over shell scripts', () => {
    const out = execSync(
      `bash -c 'SCRIPT_DIR="/tmp"; source "${AGENT_SLOT}"; har_suggest_launch 2' 2>&1`,
      { encoding: 'utf8' },
    );
    expect(out).toContain('har env launch 2');
    expect(out).toContain('har_launch_environment');
    expect(out).toContain('./.har/launch.sh 2');
    expect(out.indexOf('har env launch')).toBeLessThan(out.indexOf('./.har/launch.sh'));
  });

  // A sync takes about twenty seconds. Waiting on it would make every slot change
  // pay for the dashboard, which is what detaching the nudge exists to avoid.
  it('a slot change returns without waiting on the control sync', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-notify-'));
    const harDir = path.join(dir, '.har');
    const binDir = path.join(dir, 'bin');
    fs.mkdirSync(harDir, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(harDir, 'harness.env'), 'export HARNESS_PROJECT_NAME=demo\n');

    // Stands in for a slow CLI, and leaves a trace so we know it was reached at all.
    const witness = path.join(dir, 'witness');
    fs.writeFileSync(
      path.join(binDir, 'har'),
      `#!/usr/bin/env bash\nsleep 5\necho ran >> "${witness}"\n`,
    );
    fs.chmodSync(path.join(binDir, 'har'), 0o755);

    const script = [
      `export PATH="${binDir}:$PATH"`,
      `SCRIPT_DIR="${harDir}"`,
      `source "${harDir}/harness.env"`,
      `source "${AGENT_SLOT}"`,
      'mkdir -p "$(dirname "$(slot_registry_file 2)")"',
      'echo "{}" > "$(slot_registry_file 2)"',
      'remove_slot_registry 2',
    ].join('; ');

    const started = Date.now();
    execSync(`bash -c '${script}'`, { encoding: 'utf8' });
    const elapsed = Date.now() - started;

    expect(fs.existsSync(path.join(harDir, 'slots', 'agent-2.json'))).toBe(false);
    expect(elapsed).toBeLessThan(3000);
    expect(fs.existsSync(witness)).toBe(false); // still running, deliberately not awaited
  });

  it('har_load_infra_state reads persisted ports from infra.env', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-infra-state-'));
    const harDir = path.join(dir, '.har');
    fs.mkdirSync(path.join(harDir, 'state'), { recursive: true });
    fs.writeFileSync(
      path.join(harDir, 'state', 'infra.env'),
      'export AGENT_DB_PORT=15433\nexport AGENT_MINIO_PORT=19001\n',
    );

    const out = execSync(
      `bash -c 'SCRIPT_DIR="${harDir}"; source "${AGENT_SLOT}"; har_load_infra_state; echo "db=$AGENT_DB_PORT minio=$AGENT_MINIO_PORT"'`,
      { encoding: 'utf8' },
    ).trim();
    expect(out).toBe('db=15433 minio=19001');
  });

  it('har_load_infra_state falls back to the main checkout when worktree has no infra.env', () => {
    const main = fs.mkdtempSync(path.join(os.tmpdir(), 'har-infra-main-'));
    execSync('git init -q', { cwd: main });
    execSync('git -c user.email=har@example.com -c user.name=har -c commit.gpgsign=false commit --allow-empty -qm init', {
      cwd: main,
    });
    const mainHar = path.join(main, '.har');
    fs.mkdirSync(path.join(mainHar, 'state'), { recursive: true });
    fs.writeFileSync(path.join(mainHar, 'state', 'infra.env'), 'export AGENT_DB_PORT=15444\n');

    const worktree = path.join(main, 'wt');
    execSync(`git worktree add -q "${worktree}" -b har-agent-1`, { cwd: main });
    const worktreeHar = path.join(worktree, '.har');
    fs.mkdirSync(worktreeHar, { recursive: true });

    const out = execSync(
      `bash -c 'SCRIPT_DIR="${worktreeHar}"; REPO_ROOT="${worktree}"; source "${AGENT_SLOT}"; har_load_infra_state "${worktree}"; echo "db=$AGENT_DB_PORT"'`,
      { encoding: 'utf8' },
    ).trim();
    expect(out).toBe('db=15444');
  });

  it('har_warn_untracked_worktree names untracked paths and stays quiet when ignored', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'har-untracked-warn-'));
    execSync('git init -q', { cwd: repo });
    execSync('git -c user.email=har@example.com -c user.name=har -c commit.gpgsign=false commit --allow-empty -qm init', {
      cwd: repo,
    });
    fs.writeFileSync(path.join(repo, '.gitignore'), 'secret.env\n');
    fs.writeFileSync(path.join(repo, 'CLAUDE.md'), '# rules\n');
    fs.writeFileSync(path.join(repo, 'secret.env'), 'TOKEN=x\n');
    execSync('git add .gitignore && git -c user.email=har@example.com -c user.name=har -c commit.gpgsign=false commit -qm ignore', {
      cwd: repo,
    });

    const out = execSync(
      `bash -c 'REPO_ROOT="${repo}"; USE_WORKTREE=true; source "${AGENT_SLOT}"; har_warn_untracked_worktree' 2>&1`,
      { encoding: 'utf8' },
    );
    expect(out).toContain('WARN:');
    expect(out).toContain('CLAUDE.md');
    expect(out).not.toContain('secret.env');

    const skipped = execSync(
      `bash -c 'REPO_ROOT="${repo}"; USE_WORKTREE=false; source "${AGENT_SLOT}"; har_warn_untracked_worktree' 2>&1`,
      { encoding: 'utf8' },
    );
    expect(skipped).toBe('');
  });
});
