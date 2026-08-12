import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

const AGENT_SLOT = path.join(__dirname, '..', '.har', 'agent-slot.sh');

function sh(command: string): string {
  return execSync(command, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: '/bin/bash',
  }).trim();
}

describe('verify.sh portable timing', () => {
  it('now_ms returns a numeric millisecond timestamp', () => {
    const out = sh(`source "${AGENT_SLOT}" && now_ms`);
    expect(out).toMatch(/^\d+$/);
    expect(Number(out)).toBeGreaterThan(0);
  });

  const verifyPaths = [
    '.har/verify.sh',
    'control/.har/verify.sh',
    'src/templates/har-boilerplate/verify.sh',
    'src/templates/har-boilerplate-cli/verify.sh',
    'src/templates/har-boilerplate-ios/verify.sh',
    'src/templates/plugins/playwright/.har/stages/browser-e2e.sh',
    'src/templates/plugins/rocketsim/.har/stages/rocketsim-flows.sh',
    'src/templates/plugins/kerno/.har/stages/backend-validation.sh',
    'control/.har/stages/browser-e2e.sh',
  ];

  it.each(verifyPaths)('%s uses now_ms instead of GNU date', (relPath) => {
    const verifyScript = fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
    expect(verifyScript).toContain('$(now_ms)');
    expect(verifyScript).not.toContain('date +%s%3N');
  });

  it.each([
    'src/templates/plugins/rocketsim/.har/stages/rocketsim-flows.sh',
    'src/templates/plugins/kerno/.har/stages/backend-validation.sh',
  ])('%s avoids mapfile (absent in macOS bash 3.2)', (relPath) => {
    const script = fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
    expect(script).not.toMatch(/^\s*mapfile/m);
    expect(script).not.toMatch(/^\s*readarray/m);
  });
});

describe('stage scripts set SCRIPT_DIR to .har/', () => {
  // Stages live under .har/stages/; agent-slot.sh resolves the slot registry via
  // $SCRIPT_DIR/slots/..., so SCRIPT_DIR must be reassigned to HARNESS_DIR (.har/)
  // or verify/e2e silently falls back to the main checkout.
  const stagePaths = [
    'src/templates/plugins/playwright/.har/stages/browser-e2e.sh',
    'src/templates/plugins/rocketsim/.har/stages/rocketsim-flows.sh',
    'src/templates/plugins/kerno/.har/stages/backend-validation.sh',
    'src/templates/plugins/custom-stage-skeleton.sh',
    'control/.har/stages/browser-e2e.sh',
    'control/.har/stages/docker-build.sh',
  ];

  it.each(stagePaths)('%s reassigns SCRIPT_DIR to HARNESS_DIR', (relPath) => {
    const script = fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
    expect(script).toMatch(/HARNESS_DIR=.*\nREPO_ROOT=.*\n(?:#.*\n)*SCRIPT_DIR="\$HARNESS_DIR"/);
  });
});
