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
  defaultAgentSlotMaxForProfile,
  parseAgentSlotsFlag,
} from '../src/cli/commands/onboard';
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

  it('lists shipped plugins with descriptions', () => {
    const choices = listPluginChoices();
    const ids = choices.map((c) => c.id);
    expect(ids).toContain('playwright');
    expect(ids).toContain('rocketsim');
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

  it('enables full telemetry including prompts', async () => {
    await applyOnboardingTelemetry('on', { setupHooks: false });
    expect(isTelemetryEnabled()).toBe(true);
    expect(readTelemetryPreference().signals.prompts).toBe(true);
  });

  it('enables telemetry without prompts', async () => {
    await applyOnboardingTelemetry('on-no-prompts', { setupHooks: false });
    expect(isTelemetryEnabled()).toBe(true);
    expect(readTelemetryPreference().signals.prompts).toBe(false);
  });

  it('disables telemetry', async () => {
    await applyOnboardingTelemetry('on', { setupHooks: false });
    await applyOnboardingTelemetry('off', { setupHooks: false });
    expect(isTelemetryEnabled()).toBe(false);
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
    expect(fs.existsSync(path.join(tmpDir, '.har', 'verify.sh'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.har', 'stages', 'browser-e2e.sh'))).toBe(true);
    expect(result.adaptationPromptPath).toBe(
      path.join(tmpDir, '.har', ADAPTATION_PROMPT_FILE),
    );
    expect(result.adaptationPromptCopied).toBe(true);
    expect(clipboardCalls).toHaveLength(1);
    expect(clipboardCalls[0]).toContain('AGENT.md');
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
        ensureControl: async () => ({ started: false, apiUrl: 'http://127.0.0.1:3847' }),
        offerClipboard: async () => false,
      },
    );

    expect(second.harnessInitialized).toBe(false);
    expect(second.harnessAlreadyPresent).toBe(true);
    expect(fs.readFileSync(second.adaptationPromptPath!, 'utf8')).toContain('already exists');
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
