import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

const AGENT_SLOT = path.join(__dirname, '..', '.har', 'agent-slot.sh');

function sh(command: string, cwd?: string): string {
  return execSync(command, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

describe('verify.sh step output escaping', () => {
  it('escape_step_output retains failed steps with >50 lines of output', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-verify-shell-'));
    const script = path.join(dir, 'repro.sh');
    fs.writeFileSync(
      script,
      `#!/usr/bin/env bash
set -euo pipefail
source "${AGENT_SLOT}"
RESULTS_JSON='[{"name":"a","pass":true,"ms":1,"output":""}]'
output="$(seq 1 100)"
name="b"
pass_bool="false"
elapsed="1"
step_output_escaped=$(escape_step_output "$output")
RESULTS_JSON=$(echo "$RESULTS_JSON" | node -e "
const fs=require('fs');
let arr=JSON.parse(fs.readFileSync('/dev/stdin','utf8'));
arr.push({name:'$name',pass:$pass_bool,ms:$elapsed,output:$step_output_escaped});
process.stdout.write(JSON.stringify(arr));")
node -e "const r=$RESULTS_JSON;process.stdout.write(String(r.length)+':'+r.every(x=>x.pass))"
`,
    );
    fs.chmodSync(script, 0o755);
    const out = sh(`bash "${script}"`, dir);
    expect(out).toBe('2:false');
  });

  const verifyPaths = [
    '.har/verify.sh',
    'control/.har/verify.sh',
    'docs/.har/verify.sh',
  ];

  it.each(verifyPaths)('%s records steps without embedding passing-step output', (relPath) => {
    const verifyScript = fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
    expect(verifyScript).toContain('record_step_result "$name" "$pass_bool" "$elapsed" "$output"');
    expect(verifyScript).not.toMatch(/arr\.push\(\{name:'\$name',pass:\$pass_bool,ms:\$elapsed,output:\$step_output_escaped\}\)/);
    expect(verifyScript).not.toMatch(/step_output_escaped=\$\(echo "\$output" \| head -50/);
  });
});

describe('record_step_result', () => {
  it('omits output on pass and keeps a truncated excerpt on fail', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-record-step-'));
    const script = path.join(dir, 'repro.sh');
    fs.writeFileSync(
      script,
      `#!/usr/bin/env bash
set -euo pipefail
source "${AGENT_SLOT}"
RESULTS_JSON='[]'
record_step_result "typecheck" "true" "5" "$(seq 1 80)"
record_step_result "unit-tests" "false" "9" "$(seq 1 80)"
node -e "const r=$RESULTS_JSON;process.stdout.write(JSON.stringify(r))"
`,
    );
    fs.chmodSync(script, 0o755);
    const parsed = JSON.parse(sh(`bash "${script}"`, dir)) as Array<{
      name: string;
      pass: boolean;
      output?: string;
    }>;
    expect(parsed).toEqual([
      { name: 'typecheck', pass: true, ms: 5 },
      expect.objectContaining({
        name: 'unit-tests',
        pass: false,
        ms: 9,
      }),
    ]);
    expect(parsed[0]).not.toHaveProperty('output');
    expect(parsed[1]?.output?.split('\n')).toHaveLength(50);
  });
});
