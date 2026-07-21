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
});
