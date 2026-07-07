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
    'src/templates/har-boilerplate/verify.sh',
    'src/templates/har-boilerplate-cli/verify.sh',
    'src/templates/har-boilerplate-ios/verify.sh',
  ];

  it.each(verifyPaths)('%s escapes output without head -50 pipefail trap', (relPath) => {
    const verifyScript = fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
    expect(verifyScript).toContain('escape_step_output "$output"');
    expect(verifyScript).not.toMatch(/step_output_escaped=\$\(echo "\$output" \| head -50/);
  });
});
