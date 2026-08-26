import * as fs from 'fs';
import * as path from 'path';

describe('stage scripts use portable timing', () => {
  // now_ms (portable) instead of GNU `date +%s%3N` (absent on macOS).
  const verifyPaths = [
    'src/templates/plugins/playwright/.har/stages/browser-e2e.sh',
    'src/templates/plugins/rocketsim/.har/stages/rocketsim-flows.sh',
    'src/templates/plugins/kerno/.har/stages/backend-validation.sh',
    'src/templates/plugins/gitleaks/.har/stages/secrets-scan.sh',
    'src/templates/plugins/trivy/.har/stages/vuln-scan.sh',
    'src/templates/plugins/semgrep/.har/stages/sast.sh',
    'control/.har/stages/browser-e2e.sh',
    'control/.har/stages/docker-build.sh',
    'docs/.har/stages/browser-e2e.sh',
    'docs/.har/stages/capture-screenshots.sh',
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

describe('plugin template stage scripts follow the 1.0 stage surface', () => {
  // The runner exports WORK_DIR, ENV_FILE, AGENT_ID and HAR_HARNESS_DIR with
  // harness.env and the slot env file already sourced — agent-slot.sh is
  // retired, so a fresh plugin install must not reference it (#290).
  const stagePaths = [
    'src/templates/plugins/playwright/.har/stages/browser-e2e.sh',
    'src/templates/plugins/rocketsim/.har/stages/rocketsim-flows.sh',
    'src/templates/plugins/kerno/.har/stages/backend-validation.sh',
    'src/templates/plugins/gitleaks/.har/stages/secrets-scan.sh',
    'src/templates/plugins/trivy/.har/stages/vuln-scan.sh',
    'src/templates/plugins/semgrep/.har/stages/sast.sh',
    'src/templates/plugins/custom-stage-skeleton.sh',
  ];

  it.each(stagePaths)('%s uses the runner contract, not agent-slot.sh', (relPath) => {
    const script = fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
    expect(script).not.toMatch(/source\s+"?\$HARNESS_DIR\/agent-slot\.sh/);
    expect(script).not.toMatch(/provision-toolchain\.sh/);
    expect(script).not.toMatch(
      /\b(validate_agent_id|resolve_agent_env_file|resolve_agent_work_dir|har_suggest_launch)\b/,
    );
    expect(script).toContain(
      'HARNESS_DIR="${HAR_HARNESS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"',
    );
    expect(script).toMatch(/ENV_FILE="\$\{ENV_FILE:\?/);
    expect(script).toMatch(/WORK_DIR="\$\{WORK_DIR:\?/);
    expect(script).toMatch(/AGENT_ID="\$\{1:-\$\{AGENT_ID:\?/);
  });
});
