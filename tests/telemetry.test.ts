import { execSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ensureDefaultTelemetryPreference,
  getTelemetryPreferencePath,
  isPortalTrajectoryEnabled,
  isTelemetryEnabled,
  readTelemetryPreference,
  writePortalTrajectoryPreference,
  writeTelemetryPreference,
} from '../src/core/telemetry-config';
import {
  appendTelemetryEnvToFile,
  buildOtelResourceAttributes,
  buildSessionKey,
  buildTelemetryEnvBlock,
} from '../src/core/telemetry-env';
import {
  buildOtelHookSetupArgs,
  buildOtelHooksConfig,
  HOOK_TIMEOUT_SECONDS,
  OTEL_HOOKS_PACKAGE,
  pruneLegacyCursorHookEvents,
  rewriteHookCommandsToWrapper,
  writeOtelHooksConfig,
  writeOtelHooksWrapper,
} from '../src/core/otel-hooks';

describe('otel-hook package pin', () => {
  it('installs the release with Claude response content support', () => {
    expect(OTEL_HOOKS_PACKAGE).toBe('@osfactory/otel-hook@0.2.0');
  });
});

describe('telemetry preference', () => {
  const originalEnv = process.env.HAR_TELEMETRY;
  const originalPath = process.env.HAR_TELEMETRY_CONFIG_PATH;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-telemetry-'));
    process.env.HAR_TELEMETRY_CONFIG_PATH = path.join(tmpDir, 'telemetry.json');
    delete process.env.HAR_TELEMETRY;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.HAR_TELEMETRY;
    else process.env.HAR_TELEMETRY = originalEnv;
    if (originalPath === undefined) delete process.env.HAR_TELEMETRY_CONFIG_PATH;
    else process.env.HAR_TELEMETRY_CONFIG_PATH = originalPath;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('defaults to full telemetry (including prompts) when preference file is missing', () => {
    expect(readTelemetryPreference()).toEqual({
      enabled: true,
      signals: { metrics: true, logs: true, prompts: true, traces: true },
    });
    expect(isTelemetryEnabled()).toBe(true);
  });

  it('persists full defaults on first ensure without overwriting later', () => {
    const first = ensureDefaultTelemetryPreference();
    expect(first.enabled).toBe(true);
    expect(first.signals.prompts).toBe(true);
    expect(fs.existsSync(getTelemetryPreferencePath())).toBe(true);

    writeTelemetryPreference(true, { prompts: false });
    const second = ensureDefaultTelemetryPreference();
    expect(second.signals.prompts).toBe(false);
  });

  it('persists on/off', () => {
    writeTelemetryPreference(false);
    expect(isTelemetryEnabled()).toBe(false);
    expect(fs.existsSync(getTelemetryPreferencePath())).toBe(true);
    writeTelemetryPreference(true, { prompts: true, traces: true });
    expect(isTelemetryEnabled()).toBe(true);
    expect(readTelemetryPreference().signals.prompts).toBe(true);
  });

  it('persists prompt opt-out and defaults traces on', () => {
    writeTelemetryPreference(true, { prompts: false });
    const preference = readTelemetryPreference();
    expect(preference.signals.prompts).toBe(false);
    expect(preference.signals.traces).toBe(true);
    expect(preference.signals.metrics).toBe(true);
    expect(preference.signals.logs).toBe(true);
  });

  it('lets HAR_TELEMETRY override the file', () => {
    writeTelemetryPreference(true);
    process.env.HAR_TELEMETRY = 'off';
    expect(isTelemetryEnabled()).toBe(false);
    process.env.HAR_TELEMETRY = '1';
    expect(isTelemetryEnabled()).toBe(true);
  });
});

describe('portal trajectory opt-in', () => {
  const originalTelemetry = process.env.HAR_TELEMETRY;
  const originalTrajectory = process.env.HAR_PORTAL_TRAJECTORY;
  const originalPath = process.env.HAR_TELEMETRY_CONFIG_PATH;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-trajectory-'));
    process.env.HAR_TELEMETRY_CONFIG_PATH = path.join(tmpDir, 'telemetry.json');
    delete process.env.HAR_TELEMETRY;
    delete process.env.HAR_PORTAL_TRAJECTORY;
  });

  afterEach(() => {
    if (originalTelemetry === undefined) delete process.env.HAR_TELEMETRY;
    else process.env.HAR_TELEMETRY = originalTelemetry;
    if (originalTrajectory === undefined) delete process.env.HAR_PORTAL_TRAJECTORY;
    else process.env.HAR_PORTAL_TRAJECTORY = originalTrajectory;
    if (originalPath === undefined) delete process.env.HAR_TELEMETRY_CONFIG_PATH;
    else process.env.HAR_TELEMETRY_CONFIG_PATH = originalPath;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('is off by default even with telemetry fully on', () => {
    expect(isTelemetryEnabled()).toBe(true);
    expect(isPortalTrajectoryEnabled()).toBe(false);
  });

  it('persists the opt-in', () => {
    writePortalTrajectoryPreference(true);
    expect(isPortalTrajectoryEnabled()).toBe(true);
    writePortalTrajectoryPreference(false);
    expect(isPortalTrajectoryEnabled()).toBe(false);
  });

  it('stays off while telemetry is off', () => {
    writePortalTrajectoryPreference(true);
    writeTelemetryPreference(false);
    expect(isPortalTrajectoryEnabled()).toBe(false);
  });

  it('survives a telemetry off/on cycle', () => {
    writePortalTrajectoryPreference(true);
    writeTelemetryPreference(false);
    writeTelemetryPreference(true);
    expect(isPortalTrajectoryEnabled()).toBe(true);
  });

  it('keeps the telemetry signals when toggled', () => {
    writeTelemetryPreference(true, { prompts: false });
    writePortalTrajectoryPreference(true);
    expect(readTelemetryPreference().signals.prompts).toBe(false);
  });

  it('lets HAR_PORTAL_TRAJECTORY override the file', () => {
    process.env.HAR_PORTAL_TRAJECTORY = 'on';
    expect(isPortalTrajectoryEnabled()).toBe(true);
    writePortalTrajectoryPreference(true);
    process.env.HAR_PORTAL_TRAJECTORY = 'off';
    expect(isPortalTrajectoryEnabled()).toBe(false);
  });
});

describe('telemetry env', () => {
  const originalTelemetry = process.env.HAR_TELEMETRY;
  const originalPath = process.env.HAR_TELEMETRY_CONFIG_PATH;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-telemetry-env-'));
    process.env.HAR_TELEMETRY_CONFIG_PATH = path.join(tmpDir, 'telemetry.json');
    delete process.env.HAR_TELEMETRY;
  });

  afterEach(() => {
    if (originalTelemetry === undefined) delete process.env.HAR_TELEMETRY;
    else process.env.HAR_TELEMETRY = originalTelemetry;
    if (originalPath === undefined) delete process.env.HAR_TELEMETRY_CONFIG_PATH;
    else process.env.HAR_TELEMETRY_CONFIG_PATH = originalPath;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('builds session key from branch', () => {
    expect(buildSessionKey({ branch: 'main-abcd-har-agent-1-xy12', agentId: 1 })).toBe(
      'main-abcd-har-agent-1-xy12',
    );
  });

  it('includes har.* resource attributes without purpose', () => {
    const attrs = buildOtelResourceAttributes({
      sessionKey: 'main-abcd-har-agent-1-xy12',
      agentId: 1,
      repoPath: '/repo',
      workDir: '/repo/wt',
      branch: 'main-abcd-har-agent-1-xy12',
      suffix: 'xy12',
      workUnitId: 'ISSUE-123',
      attemptId: '11111111-1111-4111-8111-111111111111',
    });
    expect(attrs).toContain('har.session_key=main-abcd-har-agent-1-xy12');
    expect(attrs).toContain('har.agent_id=1');
    expect(attrs).toContain('har.repo_path=/repo');
    expect(attrs).toContain('har.work_unit_id=ISSUE-123');
    expect(attrs).toContain('har.attempt_id=11111111-1111-4111-8111-111111111111');
    expect(attrs).not.toContain('har.purpose');
  });

  it('writes session attribution without Claude native OTEL exporters', () => {
    process.env.HAR_TELEMETRY = '1';
    const block = buildTelemetryEnvBlock({
      sessionKey: 's1',
      agentId: 1,
      repoPath: '/repo',
      workDir: '/repo',
    });
    expect(block).toContain('HAR_SESSION_KEY=s1');
    expect(block).toContain('OTEL_RESOURCE_ATTRIBUTES=');
    expect(block).toContain('@osfactory/otel-hook');
    expect(block).not.toContain('CLAUDE_CODE_ENABLE_TELEMETRY');
    expect(block).not.toContain('OTEL_METRICS_EXPORTER');
    expect(block).not.toContain('OTEL_LOGS_EXPORTER');
    expect(block).not.toContain('OTEL_TRACES_EXPORTER');
  });

  it('replaces previous telemetry block when appending to env file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-env-'));
    const envFile = path.join(dir, '.env.agent.1');
    fs.writeFileSync(envFile, 'AGENT_ID=1\n');
    appendTelemetryEnvToFile(envFile, {
      sessionKey: 's1',
      agentId: 1,
      repoPath: '/r',
      workDir: '/r',
    });
    appendTelemetryEnvToFile(envFile, {
      sessionKey: 's2',
      agentId: 1,
      repoPath: '/r',
      workDir: '/r',
    });
    const text = fs.readFileSync(envFile, 'utf8');
    expect(text).toContain('HAR_SESSION_KEY=s2');
    expect(text.match(/HAR_SESSION_KEY=/g)?.length).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('quotes OTEL_RESOURCE_ATTRIBUTES when the repo path contains a space', () => {
    const block = buildTelemetryEnvBlock({
      sessionKey: 's1',
      agentId: 1,
      repoPath: '/Users/dev/My Projects/service',
      workDir: '/Users/dev/My Projects/service',
    });
    const line = block
      .split('\n')
      .find((l) => l.startsWith('OTEL_RESOURCE_ATTRIBUTES='));
    expect(line).toBeDefined();
    // Value is single-quoted so the space survives, and the real path is preserved.
    expect(line).toMatch(/^OTEL_RESOURCE_ATTRIBUTES='.*'$/);
    expect(line).toContain('har.repo_path=/Users/dev/My Projects/service');
  });

  it('stays safe to source when a value contains a space (issue #172)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-env-source-'));
    const envFile = path.join(dir, '.env.agent.1');
    const repoPath = '/Users/dev/My Projects/service';
    appendTelemetryEnvToFile(envFile, {
      sessionKey: 's1',
      agentId: 1,
      repoPath,
      workDir: repoPath,
    });
    // Reproduces the downstream launcher: `set -a; source <file>` then read back.
    // On the unquoted (buggy) output this bash invocation exits non-zero with
    // "No such file or directory"; execSync throws. On the fixed output it
    // sources cleanly and prints the value with the space intact.
    const out = execSync(
      `set -a; . ${JSON.stringify(envFile)}; set +a; printf '%s' "$OTEL_RESOURCE_ATTRIBUTES"`,
      { shell: '/bin/bash', encoding: 'utf8' },
    );
    expect(out).toContain(`har.repo_path=${repoPath}`);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('otel hooks config', () => {
  const originalTelemetry = process.env.HAR_TELEMETRY;
  const originalPath = process.env.HAR_TELEMETRY_CONFIG_PATH;
  const originalControl = process.env.HAR_CONTROL_API_URL;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-otel-hooks-'));
    process.env.HAR_TELEMETRY_CONFIG_PATH = path.join(tmpDir, 'telemetry.json');
    process.env.HAR_CONTROL_API_URL = 'http://localhost:3847';
    delete process.env.HAR_TELEMETRY;
  });

  afterEach(() => {
    if (originalTelemetry === undefined) delete process.env.HAR_TELEMETRY;
    else process.env.HAR_TELEMETRY = originalTelemetry;
    if (originalPath === undefined) delete process.env.HAR_TELEMETRY_CONFIG_PATH;
    else process.env.HAR_TELEMETRY_CONFIG_PATH = originalPath;
    if (originalControl === undefined) delete process.env.HAR_CONTROL_API_URL;
    else process.env.HAR_CONTROL_API_URL = originalControl;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('maps HAR signals to @osfactory/otel-hook config with protobuf endpoint', () => {
    writeTelemetryPreference(true);
    const config = buildOtelHooksConfig({ enabled: true, apiUrl: 'http://localhost:3847' });
    expect(config.exporter.endpoint).toBe('http://localhost:3847/api/otel/v1/traces');
    expect(config.exporter.protocol).toBe('http/protobuf');
    expect(config.exporter.enabled).toBe(true);
    expect(config.exporter.logs.enabled).toBe(true);
    expect(config.exporter.logs.includeContent).toBe(true);
    expect(config.privacy.contentMode).toBe('raw');
    expect(config.privacy.allowRawContent).toBe(true);
  });

  it('disables prompt capture when prompts signal is off', () => {
    writeTelemetryPreference(true, { prompts: false });
    const config = buildOtelHooksConfig({ enabled: true, apiUrl: 'http://localhost:3847' });
    expect(config.privacy.contentMode).toBe('omit');
    expect(config.privacy.allowRawContent).toBe(false);
    expect(config.exporter.logs.includeContent).toBe(false);
  });

  it('disables exporter when telemetry is off', () => {
    const config = buildOtelHooksConfig({ enabled: false, apiUrl: 'http://localhost:3847' });
    expect(config.exporter.enabled).toBe(false);
    expect(config.exporter.endpoint).toBeUndefined();
    expect(config.privacy.contentMode).toBe('omit');
  });

  it('writes config JSON under hooks home', () => {
    const hooksHome = path.join(tmpDir, 'hooks');
    const config = buildOtelHooksConfig({ enabled: true, apiUrl: 'http://localhost:3847' });
    const configPath = writeOtelHooksConfig(config, hooksHome);
    expect(configPath).toBe(path.join(hooksHome, 'otel_config.json'));
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      exporter: { protocol: string; endpoint?: string };
      privacy: { contentMode: string };
      _comment?: string;
    };
    expect(parsed.exporter.protocol).toBe('http/protobuf');
    expect(parsed.exporter.endpoint).toBe('http://localhost:3847/api/otel/v1/traces');
    // otel-hook rejects unknown keys and disables OTLP; keep the file schema-clean.
    expect(parsed).not.toHaveProperty('_comment');
    expect(Object.keys(parsed).sort()).toEqual(['exporter', 'privacy']);
  });

  it('rewrites hooks.json commands to the HAR wrapper', () => {
    const hooksFile = path.join(tmpDir, 'hooks.json');
    fs.writeFileSync(
      hooksFile,
      JSON.stringify({
        version: 1,
        hooks: {
          sessionStart: [{ command: 'otel-hook', timeout: 5 }],
        },
      }),
    );
    const wrapper = '/tmp/har-run-otel-hook.sh';
    expect(rewriteHookCommandsToWrapper(hooksFile, wrapper)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(hooksFile, 'utf8')) as {
      hooks: { sessionStart: Array<{ command: string }> };
    };
    expect(parsed.hooks.sessionStart[0].command).toBe(wrapper);
  });

  it('upgrades a copied Python hook command to the HAR wrapper', () => {
    const hooksFile = path.join(tmpDir, 'legacy-hooks.json');
    fs.writeFileSync(
      hooksFile,
      JSON.stringify({
        version: 1,
        hooks: {
          sessionStart: [
            {
              command:
                'python3 /repo/.cursor/hooks/opentelemetry-hook/otel_hook.py --cursor',
            },
          ],
        },
      }),
    );
    const wrapper = '/tmp/har-run-otel-hook.sh';
    expect(rewriteHookCommandsToWrapper(hooksFile, wrapper)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(hooksFile, 'utf8')) as {
      hooks: { sessionStart: Array<{ command: string }> };
    };
    expect(parsed.hooks.sessionStart[0].command).toBe(`${wrapper} --provider cursor`);
  });

  it('normalizes legacy --cursor on an already-wrapped command', () => {
    const hooksFile = path.join(tmpDir, 'wrapped-legacy-flags.json');
    const wrapper = '/tmp/har-run-otel-hook.sh';
    fs.writeFileSync(
      hooksFile,
      JSON.stringify({
        version: 1,
        hooks: {
          beforeShellExecution: [{ command: `${wrapper} --cursor` }],
        },
      }),
    );
    expect(rewriteHookCommandsToWrapper(hooksFile, wrapper)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(hooksFile, 'utf8')) as {
      hooks: { beforeShellExecution: Array<{ command: string }> };
    };
    expect(parsed.hooks.beforeShellExecution[0].command).toBe(`${wrapper} --provider cursor`);
  });

  it('prunes legacy-only Cursor hook events registered by the Python installer', () => {
    const hooksFile = path.join(tmpDir, 'cursor-hooks.json');
    const wrapper = '/tmp/har-run-otel-hook.sh';
    fs.writeFileSync(
      hooksFile,
      JSON.stringify({
        version: 1,
        hooks: {
          preToolUse: [{ command: `${wrapper} --provider cursor` }],
          beforeShellExecution: [
            { command: 'other-tool do-something' },
            { command: `${wrapper} --provider cursor` },
          ],
          subagentStart: [{ command: `${wrapper} --provider cursor` }],
        },
      }),
    );
    expect(pruneLegacyCursorHookEvents(hooksFile, wrapper)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(hooksFile, 'utf8')) as {
      hooks: Record<string, unknown>;
    };
    expect(parsed.hooks.preToolUse).toBeDefined();
    expect(parsed.hooks.beforeShellExecution).toEqual([{ command: 'other-tool do-something' }]);
    expect(parsed.hooks.subagentStart).toBeUndefined();
  });

  it('writes a wrapper that invokes the TypeScript CLI with HAR paths', () => {
    const hooksHome = path.join(tmpDir, 'hooks');
    const binary = path.join(hooksHome, 'node_modules', '.bin', 'otel-hook');
    const wrapper = writeOtelHooksWrapper(binary, hooksHome);
    const script = fs.readFileSync(wrapper, 'utf8');
    expect(script).toContain(`"${binary}" run`);
    expect(script).toContain(`--config-file "${path.join(hooksHome, 'otel_config.json')}"`);
    expect(script).toContain(`--state-dir "${path.join(hooksHome, 'state')}"`);
    expect(script).not.toContain('python');
    expect(fs.statSync(wrapper).mode & 0o111).not.toBe(0);
  });

  // #328: hooks fire on session start, every prompt, before/after every tool
  // call and on stop. An unbounded export turns an unreachable Mission Control
  // into a stalled agent session, which reads exactly like a broken model API.
  describe('hook budgets', () => {
    it('bounds the export so an unreachable collector cannot stall a turn', () => {
      const hooksHome = path.join(tmpDir, 'hooks-budget');
      const binary = path.join(hooksHome, 'node_modules', '.bin', 'otel-hook');
      const script = fs.readFileSync(writeOtelHooksWrapper(binary, hooksHome), 'utf8');

      const exportTimeout = script.match(/--timeout-ms (\d+)/);
      const flushTimeout = script.match(/--flush-timeout-ms (\d+)/);

      expect(exportTimeout).not.toBeNull();
      expect(flushTimeout).not.toBeNull();
      expect(Number(exportTimeout![1])).toBeGreaterThan(0);
      // Both budgets must fit inside the per-hook ceiling the agent enforces,
      // so the hook returns on its own instead of being killed.
      expect(Number(exportTimeout![1]) + Number(flushTimeout![1])).toBeLessThan(
        HOOK_TIMEOUT_SECONDS * 1000,
      );
    });

    it('never fails an agent turn because telemetry failed', () => {
      const hooksHome = path.join(tmpDir, 'hooks-exit');
      const binary = path.join(hooksHome, 'node_modules', '.bin', 'otel-hook');
      const script = fs.readFileSync(writeOtelHooksWrapper(binary, hooksHome), 'utf8');

      // A non-zero hook exit can block a tool call; dropped telemetry must not.
      expect(script).toContain('|| true');
      expect(script.trim().endsWith('exit 0')).toBe(true);
      // `exec` would replace the shell and leak the child's status.
      expect(script).not.toContain('exec "');
      expect(script).not.toContain('set -euo pipefail');
    });

    it('writes a per-hook timeout into every generated hook entry', () => {
      const args = buildOtelHookSetupArgs('claude-code', '/home/dev/.har/otel-hooks/run-otel-hook.sh');
      const index = args.indexOf('--timeout-seconds');

      expect(index).toBeGreaterThan(-1);
      expect(Number(args[index + 1])).toBe(HOOK_TIMEOUT_SECONDS);
      expect(Number(args[index + 1])).toBeGreaterThan(0);
    });

    it('runs the wrapper successfully even when the hook binary is missing', () => {
      const hooksHome = path.join(tmpDir, 'hooks-missing-binary');
      const wrapper = writeOtelHooksWrapper(
        path.join(hooksHome, 'node_modules', '.bin', 'does-not-exist'),
        hooksHome,
      );

      const result = spawnSync('bash', [wrapper, '--provider', 'claude-code'], {
        encoding: 'utf8',
      });

      expect(result.status).toBe(0);
    });
  });
});
