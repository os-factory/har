import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  applyOnboardingTelemetry,
  finalizeOnboardingAdaptation,
  listPluginChoices,
  ONBOARDING_GUIDE_STEPS,
  runOnboarding,
} from '../src/core/onboarding';
import {
  coerceTelemetryFlag,
  defaultAgentSlotMaxForProfile,
  defaultStartControl,
  defaultTelemetryLevel,
  parseAgentSlotsFlag,
} from '../src/cli/commands/onboard';
import { telemetryLevelChoices } from '../src/cli/telemetry-prompts';
import { DOCKER_INSTALL_URL, type DockerStatus } from '../src/core/docker-status';
import {
  isTelemetryEnabled,
  readTelemetryPreference,
} from '../src/core/telemetry-config';
import { ADAPTATION_PROMPT_FILE } from '../src/harness/adaptation-prompt';

describe('onboarding guide', () => {
  it('covers the core HAR concepts', () => {
    const titles = ONBOARDING_GUIDE_STEPS.map((step) => step.title);
    expect(titles).toEqual([
      'What HAR is',
      'What you need',
      'Sessions and slots',
      'Verify and finish',
      'Mission Control and plugins',
    ]);
    const body = ONBOARDING_GUIDE_STEPS.map((step) => step.body).join('\n');
    expect(body).toContain('har env launch');
    expect(body).toContain('complete');
    expect(body).toContain('Mission Control');
    expect(body).toContain('add-plugin');
  });

  it('tells the user Docker is required', () => {
    const requirements = ONBOARDING_GUIDE_STEPS.find((step) => step.title === 'What you need');
    expect(requirements?.body).toContain('Docker is required');
    expect(requirements?.body).toContain(DOCKER_INSTALL_URL);
  });

  it('lists shipped plugins with descriptions', () => {
    const choices = listPluginChoices();
    const ids = choices.map((c) => c.id);
    expect(ids).toContain('playwright');
    expect(ids).toContain('rocketsim');
    expect(ids).toContain('kerno');
    expect(ids).toContain('gitleaks');
    expect(ids).toContain('trivy');
    expect(ids).toContain('semgrep');
    expect(ids).toContain('cypress');
    expect(choices.every((c) => c.label.includes(c.id))).toBe(true);
  });
});

describe('agent slot onboarding helpers', () => {
  it('uses profile defaults for agentSlots.max', () => {
    expect(defaultAgentSlotMaxForProfile('default')).toBe(5);
    expect(defaultAgentSlotMaxForProfile('cli')).toBe(3);
    expect(defaultAgentSlotMaxForProfile('ios')).toBe(3);
  });

  it('validates --agent-slots bounds', () => {
    expect(parseAgentSlotsFlag(undefined)).toBeUndefined();
    expect(parseAgentSlotsFlag(1)).toBe(1);
    expect(parseAgentSlotsFlag(10)).toBe(10);
    expect(() => parseAgentSlotsFlag(0)).toThrow(/1 to 10/);
    expect(() => parseAgentSlotsFlag(11)).toThrow(/1 to 10/);
    expect(() => parseAgentSlotsFlag(1.5)).toThrow(/1 to 10/);
  });
});

describe('applyOnboardingTelemetry', () => {
  const originalEnv = process.env.HAR_TELEMETRY;
  const originalPath = process.env.HAR_TELEMETRY_CONFIG_PATH;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-onboard-tel-'));
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

  it('stores each level with its full signal set', async () => {
    await applyOnboardingTelemetry('full', { setupHooks: false });
    expect(readTelemetryPreference().level).toBe('full');
    expect(readTelemetryPreference().signals).toEqual({
      metrics: true,
      traces: true,
      logs: true,
      prompts: true,
    });

    await applyOnboardingTelemetry('outline', { setupHooks: false });
    expect(readTelemetryPreference().signals).toEqual({
      metrics: true,
      traces: true,
      logs: true,
      prompts: false,
    });

    await applyOnboardingTelemetry('usage', { setupHooks: false });
    expect(readTelemetryPreference().signals).toEqual({
      metrics: true,
      traces: false,
      logs: false,
      prompts: false,
    });
  });

  it('restores the full signal set over a preference that had dropped logs', async () => {
    fs.writeFileSync(
      process.env.HAR_TELEMETRY_CONFIG_PATH!,
      JSON.stringify({ level: 'usage', signals: { logs: false } }),
    );
    await applyOnboardingTelemetry('full', { setupHooks: false });
    expect(readTelemetryPreference().signals.logs).toBe(true);
  });

  it('disables telemetry', async () => {
    await applyOnboardingTelemetry('full', { setupHooks: false });
    await applyOnboardingTelemetry('off', { setupHooks: false });
    expect(isTelemetryEnabled()).toBe(false);
  });
});

describe('telemetry level defaults and flags', () => {
  const originalPath = process.env.HAR_TELEMETRY_CONFIG_PATH;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-onboard-level-'));
    process.env.HAR_TELEMETRY_CONFIG_PATH = path.join(tmpDir, 'telemetry.json');
  });

  afterEach(() => {
    if (originalPath === undefined) delete process.env.HAR_TELEMETRY_CONFIG_PATH;
    else process.env.HAR_TELEMETRY_CONFIG_PATH = originalPath;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('offers full on a machine with no choice yet', () => {
    expect(defaultTelemetryLevel()).toBe('full');
  });

  it('offers the level already chosen on this machine', async () => {
    await applyOnboardingTelemetry('usage', { setupHooks: false });
    expect(defaultTelemetryLevel()).toBe('usage');
  });

  it('accepts levels and the older spellings for --telemetry', () => {
    expect(coerceTelemetryFlag('outline')).toBe('outline');
    expect(coerceTelemetryFlag('on')).toBe('full');
    expect(coerceTelemetryFlag('on-no-prompts')).toBe('outline');
    expect(coerceTelemetryFlag(undefined)).toBeUndefined();
    expect(() => coerceTelemetryFlag('everything')).toThrow(/Unknown --telemetry value/);
  });

  it('offers the four levels, most detailed first', () => {
    expect(telemetryLevelChoices().map((choice) => choice.value)).toEqual([
      'full',
      'outline',
      'usage',
      'off',
    ]);
  });
});

const DOCKER_OK: DockerStatus = { cliInstalled: true, daemonRunning: true, version: '27.3.1' };
const DOCKER_MISSING: DockerStatus = { cliInstalled: false, daemonRunning: false };

describe('Mission Control start default', () => {
  it('is on when telemetry is on and Docker is usable', () => {
    expect(defaultStartControl('full', DOCKER_OK)).toBe(true);
    expect(defaultStartControl('usage', DOCKER_OK)).toBe(true);
  });

  it('is off when telemetry is off or Docker is unusable', () => {
    expect(defaultStartControl('off', DOCKER_OK)).toBe(false);
    expect(defaultStartControl('full', DOCKER_MISSING)).toBe(false);
    expect(defaultStartControl('full', { cliInstalled: true, daemonRunning: false })).toBe(false);
  });
});

describe('runOnboarding', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-onboard-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('scaffolds a harness, applies plugins, and finishes with an adapt prompt', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'onboard-fixture', version: '1.0.0' }, null, 2) + '\n',
    );
    const clipboardCalls: string[] = [];
    const result = await runOnboarding(
      {
        repoPath: tmpDir,
        profile: 'cli',
        telemetry: 'off',
        startControl: false,
        plugins: ['playwright'],
        autoYes: true,
      },
      {
        applyTelemetry: async () => {},
        detectDocker: () => DOCKER_OK,
        ensureControl: async () => ({ started: false, apiUrl: 'http://127.0.0.1:3847' }),
        offerClipboard: async (content) => {
          clipboardCalls.push(content);
          return true;
        },
      },
    );

    expect(result.harnessInitialized).toBe(true);
    expect(result.pluginsApplied).toEqual(['playwright']);
    expect(result.agentSlots).toEqual({ min: 1, max: 3 });
    expect(fs.existsSync(path.join(tmpDir, '.har', 'verify.sh'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.har', 'stages', 'browser-e2e.sh'))).toBe(true);
    expect(result.adaptationPromptPath).toBe(
      path.join(tmpDir, '.har', ADAPTATION_PROMPT_FILE),
    );
    expect(result.adaptationPromptCopied).toBe(true);
    expect(clipboardCalls).toHaveLength(1);
    expect(clipboardCalls[0]).toContain('AGENTS.md');
  });

  it('applies agentSlotsMax to stages.json after scaffold', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'onboard-slots', version: '1.0.0' }, null, 2) + '\n',
    );
    const result = await runOnboarding(
      {
        repoPath: tmpDir,
        profile: 'cli',
        telemetry: 'off',
        startControl: false,
        plugins: [],
        autoYes: true,
        agentSlotsMax: 2,
        deferAdaptationPrompt: true,
      },
      {
        applyTelemetry: async () => {},
        detectDocker: () => DOCKER_OK,
        ensureControl: async () => ({ started: false, apiUrl: 'http://127.0.0.1:3847' }),
      },
    );

    expect(result.harnessInitialized).toBe(true);
    expect(result.agentSlots).toEqual({ min: 1, max: 2 });
    const stages = JSON.parse(fs.readFileSync(path.join(tmpDir, '.har', 'stages.json'), 'utf8'));
    expect(stages.agentSlots).toEqual({ min: 1, max: 2 });
    const env = fs.readFileSync(path.join(tmpDir, '.har', 'harness.env'), 'utf8');
    expect(env).toContain('export HARNESS_AGENT_SLOT_MAX=2');
  });

  it('skips init when harness already exists and still offers a maintain prompt', async () => {
    await runOnboarding(
      {
        repoPath: tmpDir,
        profile: 'cli',
        telemetry: 'off',
        startControl: false,
        plugins: [],
        autoYes: true,
        deferAdaptationPrompt: true,
      },
      {
        applyTelemetry: async () => {},
        detectDocker: () => DOCKER_OK,
        ensureControl: async () => ({ started: false, apiUrl: 'http://127.0.0.1:3847' }),
      },
    );

    const second = await runOnboarding(
      {
        repoPath: tmpDir,
        profile: 'cli',
        telemetry: 'off',
        startControl: false,
        plugins: [],
        autoYes: true,
      },
      {
        applyTelemetry: async () => {},
        detectDocker: () => DOCKER_OK,
        ensureControl: async () => ({ started: false, apiUrl: 'http://127.0.0.1:3847' }),
        offerClipboard: async () => false,
      },
    );

    expect(second.harnessInitialized).toBe(false);
    expect(second.harnessAlreadyPresent).toBe(true);
    expect(fs.readFileSync(second.adaptationPromptPath!, 'utf8')).toContain('already exists');
  });

  it('warns that Docker is required when the engine is unavailable', async () => {
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await runOnboarding(
        {
          repoPath: tmpDir,
          profile: 'cli',
          telemetry: 'off',
          startControl: false,
          plugins: [],
          skipInit: true,
          autoYes: true,
        },
        {
          applyTelemetry: async () => {},
          detectDocker: () => DOCKER_MISSING,
          ensureControl: async () => ({ started: false, apiUrl: 'http://127.0.0.1:3847' }),
        },
      );

      expect(result.docker).toEqual(DOCKER_MISSING);
      expect(result.dockerWarning).toContain('Docker is required');
      const logged = errors.mock.calls.map((call) => String(call[0])).join('\n');
      expect(logged).toContain('Docker is required');
    } finally {
      errors.mockRestore();
    }
  });

  it('does not warn twice when the caller already reported Docker status', async () => {
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await runOnboarding(
        {
          repoPath: tmpDir,
          profile: 'cli',
          telemetry: 'off',
          startControl: false,
          plugins: [],
          skipInit: true,
          autoYes: true,
          docker: DOCKER_MISSING,
        },
        {
          applyTelemetry: async () => {},
          detectDocker: () => {
            throw new Error('should not probe Docker when the caller passed a status');
          },
          ensureControl: async () => ({ started: false, apiUrl: 'http://127.0.0.1:3847' }),
        },
      );

      expect(result.dockerWarning).toContain('Docker is required');
      const logged = errors.mock.calls.map((call) => String(call[0])).join('\n');
      expect(logged).not.toContain('Docker is required');
    } finally {
      errors.mockRestore();
    }
  });

  it('reports no Docker warning when the engine is usable', async () => {
    const result = await runOnboarding(
      {
        repoPath: tmpDir,
        profile: 'cli',
        telemetry: 'off',
        startControl: false,
        plugins: [],
        skipInit: true,
        autoYes: true,
      },
      {
        applyTelemetry: async () => {},
        detectDocker: () => DOCKER_OK,
        ensureControl: async () => ({ started: false, apiUrl: 'http://127.0.0.1:3847' }),
      },
    );

    expect(result.docker).toEqual(DOCKER_OK);
    expect(result.dockerWarning).toBeNull();
  });

  it('honors skipInit', async () => {
    const result = await runOnboarding(
      {
        repoPath: tmpDir,
        profile: 'cli',
        telemetry: 'off',
        startControl: false,
        plugins: [],
        skipInit: true,
        autoYes: true,
      },
      {
        applyTelemetry: async () => {},
        detectDocker: () => DOCKER_OK,
        ensureControl: async () => ({ started: false, apiUrl: 'http://127.0.0.1:3847' }),
      },
    );

    expect(result.harnessInitialized).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.har'))).toBe(false);
    expect(result.adaptationPromptPath).toBeNull();
    expect(result.agentSlots).toBeNull();
  });
});

describe('finalizeOnboardingAdaptation', () => {
  it('writes the init prompt after a fresh scaffold', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-onboard-final-'));
    fs.mkdirSync(path.join(tmpDir, '.har'), { recursive: true });

    const finalized = await finalizeOnboardingAdaptation({
      repoPath: tmpDir,
      profile: 'default',
      harnessInitialized: true,
      autoYes: true,
      offerClipboard: async () => true,
    });

    expect(finalized.copied).toBe(true);
    expect(fs.readFileSync(finalized.path, 'utf8')).toContain('Profile: default');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
