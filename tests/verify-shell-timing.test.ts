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

describe('plugin template stage scripts set SCRIPT_DIR to .har/', () => {
  // Plugin templates still resolve paths relative to the harness dir; this
  // repo's own stage scripts are migrated to the 1.0 stage surface (WORK_DIR /
  // ENV_FILE / AGENT_ID exported by the runner) and are covered above.
  const stagePaths = [
    'src/templates/plugins/playwright/.har/stages/browser-e2e.sh',
    'src/templates/plugins/rocketsim/.har/stages/rocketsim-flows.sh',
    'src/templates/plugins/kerno/.har/stages/backend-validation.sh',
    'src/templates/plugins/gitleaks/.har/stages/secrets-scan.sh',
    'src/templates/plugins/trivy/.har/stages/vuln-scan.sh',
    'src/templates/plugins/semgrep/.har/stages/sast.sh',
    'src/templates/plugins/custom-stage-skeleton.sh',
  ];

  it.each(stagePaths)('%s reassigns SCRIPT_DIR to HARNESS_DIR', (relPath) => {
    const script = fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
    expect(script).toMatch(/HARNESS_DIR=.*\nREPO_ROOT=.*\n(?:#.*\n)*SCRIPT_DIR="\$HARNESS_DIR"/);
  });
});
