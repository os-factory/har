import { execSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ensureDefaultTelemetryPreference,
  getTelemetryPreferencePath,
  isPortalTrajectoryEnabled,
  isTelemetryEnabled,
  getTelemetryLevel,
  getTelemetrySignals,
  parseTelemetryLevel,
  readTelemetryPreference,
  signalsForLevel,
  writePortalTrajectoryPreference,
  writeTelemetryLevel,
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
  inspectTelemetryDrift,
  needsPackageInstall,
  OTEL_HOOKS_PACKAGE,
  pruneLegacyCursorHookEvents,
  recordInstalledSpec,
  rewriteHookCommandsToWrapper,
  writeOtelHooksConfig,
  writeOtelHooksWrapper,
} from '../src/core/otel-hooks';

describe('otel-hook package pin', () => {
  it('installs the release that reads the Resource session.id and the standard OTLP variables', () => {
    expect(OTEL_HOOKS_PACKAGE).toBe('@osfactory/otel-hook@0.8.0');
  });

  it('is the version Mission Control derives otel-hook ids with', () => {
    const control = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'control', 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(`@osfactory/otel-hook@${control.dependencies['@osfactory/otel-hook']}`).toBe(OTEL_HOOKS_PACKAGE);
  });

  describe('HAR_OTEL_HOOKS_PACKAGE override', () => {
    let home: string;
    const installVersion = (version: string) => {
      const pkgDir = path.join(home, 'node_modules', '@osfactory', 'otel-hook');
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ version }));
    };
    beforeEach(() => {
      home = fs.mkdtempSync(path.join(os.tmpdir(), 'har-otel-pkg-'));
    });
    afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

    it('keeps an install of the pinned version', () => {
      installVersion('0.8.0');
      expect(needsPackageInstall(home, OTEL_HOOKS_PACKAGE)).toBe(false);
      installVersion('0.5.0');
      expect(needsPackageInstall(home, OTEL_HOOKS_PACKAGE)).toBe(true);
    });

    it('installs an override once, then again only when it changes or is removed', () => {
      installVersion('0.8.0');
      expect(needsPackageInstall(home, '/tmp/otel-hook.tgz')).toBe(true);
      recordInstalledSpec(home, '/tmp/otel-hook.tgz');
      expect(needsPackageInstall(home, '/tmp/otel-hook.tgz')).toBe(false);
      expect(needsPackageInstall(home, '@osfactory/otel-hook@0.9.0')).toBe(true);
      // Back to the pin: the override's build is replaced even at the same version.
      expect(needsPackageInstall(home, OTEL_HOOKS_PACKAGE)).toBe(true);
      recordInstalledSpec(home, OTEL_HOOKS_PACKAGE);
      expect(needsPackageInstall(home, OTEL_HOOKS_PACKAGE)).toBe(false);
    });
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

  it('defaults to the full level when the preference file is missing', () => {
    expect(readTelemetryPreference()).toEqual({
      enabled: true,
      level: 'full',
      signals: { metrics: true, logs: true, prompts: true, traces: true },
    });
    expect(isTelemetryEnabled()).toBe(true);
  });

  it('persists the default on first ensure without overwriting later', () => {
    const first = ensureDefaultTelemetryPreference();
    expect(first.level).toBe('full');
    expect(fs.existsSync(getTelemetryPreferencePath())).toBe(true);

    writeTelemetryLevel('outline');
    expect(ensureDefaultTelemetryPreference().level).toBe('outline');
  });

  it('derives every signal from the level', () => {
    expect(signalsForLevel('off')).toEqual({ metrics: false, traces: false, logs: false, prompts: false });
    expect(signalsForLevel('usage')).toEqual({ metrics: true, traces: false, logs: false, prompts: false });
    expect(signalsForLevel('outline')).toEqual({ metrics: true, traces: true, logs: true, prompts: false });
    expect(signalsForLevel('full')).toEqual({ metrics: true, traces: true, logs: true, prompts: true });
  });

  it('never records prompts without the event records that carry them', () => {
    for (const level of ['off', 'usage', 'outline', 'full'] as const) {
      const signals = signalsForLevel(level);
      if (signals.prompts) expect(signals.logs && signals.traces).toBe(true);
    }
  });

  it('replaces the previous level outright', () => {
    writeTelemetryLevel('usage');
    writeTelemetryLevel('full');
    expect(readTelemetryPreference().signals).toEqual(signalsForLevel('full'));
    writeTelemetryLevel('off');
    expect(isTelemetryEnabled()).toBe(false);
    writeTelemetryLevel('outline');
    expect(getTelemetrySignals()).toEqual(signalsForLevel('outline'));
  });

  it('reads a pre-level file that asked for prompts but disabled logs as full', () => {
    // The state `har telemetry on` used to leave behind: prompts on, yet no
    // channel to carry them, so agents recorded outlines only.
    fs.writeFileSync(
      getTelemetryPreferencePath(),
      JSON.stringify({
        enabled: true,
        signals: { metrics: false, logs: false, prompts: true, traces: true },
      }),
    );
    expect(readTelemetryPreference().level).toBe('full');
    expect(getTelemetrySignals()).toEqual(signalsForLevel('full'));
  });

  it('maps the other pre-level files to the level they meant', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ enabled: false, signals: { prompts: true } }, 'off'],
      [{ enabled: true, signals: { prompts: false } }, 'outline'],
      [{ enabled: true, signals: { prompts: false, traces: false, logs: false } }, 'usage'],
      [{ enabled: true }, 'full'],
    ];
    for (const [file, level] of cases) {
      fs.writeFileSync(getTelemetryPreferencePath(), JSON.stringify(file));
      expect(readTelemetryPreference().level).toBe(level);
    }
  });

  it('accepts levels and the older on / on-no-prompts spellings', () => {
    expect(parseTelemetryLevel('outline')).toBe('outline');
    expect(parseTelemetryLevel('on')).toBe('full');
    expect(parseTelemetryLevel('on-no-prompts')).toBe('outline');
    expect(parseTelemetryLevel('verbose')).toBeUndefined();
  });

  it('lets HAR_TELEMETRY override the file', () => {
    writeTelemetryLevel('outline');
    process.env.HAR_TELEMETRY = 'off';
    expect(isTelemetryEnabled()).toBe(false);
    process.env.HAR_TELEMETRY = '1';
    expect(getTelemetryLevel()).toBe('outline');
    process.env.HAR_TELEMETRY = 'usage';
    expect(getTelemetryLevel()).toBe('usage');
    writeTelemetryLevel('off');
    process.env.HAR_TELEMETRY = 'on';
    expect(getTelemetryLevel()).toBe('full');
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
    writeTelemetryLevel('off');
    expect(isPortalTrajectoryEnabled()).toBe(false);
  });

  it('survives a telemetry off/on cycle', () => {
    writePortalTrajectoryPreference(true);
    writeTelemetryLevel('off');
    writeTelemetryLevel('full');
    expect(isPortalTrajectoryEnabled()).toBe(true);
  });

  it('keeps the telemetry level when toggled', () => {
    writeTelemetryLevel('outline');
    writePortalTrajectoryPreference(true);
    expect(readTelemetryPreference().level).toBe('outline');
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

  it('includes the 2.0 session resource attributes and no har.* key', () => {
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
    expect(attrs).toContain('session.id=main-abcd-har-agent-1-xy12');
    expect(attrs).toContain('factory.slot.id=1');
    expect(attrs).toContain('factory.local.checkout_path=/repo');
    expect(attrs).toContain('factory.local.work_dir=/repo/wt');
    expect(attrs).toContain('factory.work_unit.id=ISSUE-123');
    expect(attrs).toContain('factory.attempt.id=11111111-1111-4111-8111-111111111111');
    expect(attrs).not.toContain('har.');
  });

  it('writes session attribution without Claude native OTEL exporters', () => {
    process.env.HAR_TELEMETRY = '1';
    const block = buildTelemetryEnvBlock({
      sessionKey: 's1',
      agentId: 1,
      repoPath: '/repo',
      workDir: '/repo',
    });
    expect(block).not.toContain('HAR_SESSION_KEY');
    expect(block).toContain('session.id=s1');
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
    expect(text).toContain('session.id=s2');
    expect(text.match(/OTEL_RESOURCE_ATTRIBUTES=/g)?.length).toBe(1);
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
    expect(line).toContain('factory.local.checkout_path=/Users/dev/My Projects/service');
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
    expect(out).toContain(`factory.local.checkout_path=${repoPath}`);
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

  it('maps the full level to @osfactory/otel-hook config with protobuf endpoint', () => {
    writeTelemetryLevel('full');
    const config = buildOtelHooksConfig({ enabled: true, apiUrl: 'http://localhost:3847' });
    expect(config.exporter.endpoint).toBe('http://localhost:3847/api/otel/v1/traces');
    expect(config.exporter.protocol).toBe('http/protobuf');
    expect(config.exporter.enabled).toBe(true);
    expect(config.exporter.logs.enabled).toBe(true);
    expect(config.exporter.logs.includeContent).toBe(true);
    expect(config.privacy.contentMode).toBe('raw');
    expect(config.privacy.allowRawContent).toBe(true);
  });

  it('exports steps without text at the outline level', () => {
    writeTelemetryLevel('outline');
    const config = buildOtelHooksConfig({ apiUrl: 'http://localhost:3847' });
    expect(config.exporter.enabled).toBe(true);
    expect(config.exporter.logs.enabled).toBe(true);
    expect(config.privacy.contentMode).toBe('omit');
    expect(config.privacy.allowRawContent).toBe(false);
    expect(config.exporter.logs.includeContent).toBe(false);
  });

  it('exports nothing from the hook at the usage level', () => {
    writeTelemetryLevel('usage');
    const config = buildOtelHooksConfig({ apiUrl: 'http://localhost:3847' });
    expect(config.exporter.enabled).toBe(false);
    expect(config.exporter.logs.enabled).toBe(false);
    expect(config.privacy.contentMode).toBe('omit');
  });

  it('reports a hook config that records less than the level asks for', () => {
    writeTelemetryLevel('full');
    const hooksHome = path.join(tmpDir, 'hooks');
    // The file the old `har telemetry on` left: text capture on, its channel off.
    const stale = buildOtelHooksConfig({ apiUrl: 'http://localhost:3847' });
    stale.exporter.logs.enabled = false;
    delete stale.exporter.logs.endpoint;
    writeOtelHooksConfig(stale, hooksHome);
    const drift = inspectTelemetryDrift(hooksHome);
    expect(drift.level).toBe('full');
    expect(drift.mismatches).toEqual([expect.stringContaining('event records export: false')]);

    writeOtelHooksConfig(buildOtelHooksConfig({ apiUrl: 'http://localhost:3847' }), hooksHome);
    expect(inspectTelemetryDrift(hooksHome).mismatches).toEqual([]);
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
