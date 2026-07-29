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
    'control/.har/stages/browser-e2e.sh',
  ];

  it.each(verifyPaths)('%s uses now_ms instead of GNU date', (relPath) => {
    const verifyScript = fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
    expect(verifyScript).toContain('$(now_ms)');
    expect(verifyScript).not.toContain('date +%s%3N');
  });

  it('rocketsim-flows.sh avoids mapfile (absent in macOS bash 3.2)', () => {
    const script = fs.readFileSync(
      path.join(__dirname, '..', 'src/templates/plugins/rocketsim/.har/stages/rocketsim-flows.sh'),
      'utf8',
    );
    expect(script).not.toMatch(/^\s*mapfile/m);
  });
});
