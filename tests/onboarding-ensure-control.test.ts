const ensureTelemetryInfrastructure = jest.fn();
const ensureRepoRegisteredWithControl = jest.fn();
const isControlApiReachable = jest.fn();
const startControlAndSync = jest.fn();

jest.mock('../src/core/control-config', () => ({
  getControlApiUrl: () => 'http://127.0.0.1:3847',
}));
jest.mock('../src/core/telemetry-ensure', () => ({
  ensureTelemetryInfrastructure: (...args: unknown[]) => ensureTelemetryInfrastructure(...args),
}));
jest.mock('../src/core/control-sync', () => ({
  isControlApiReachable: (...args: unknown[]) => isControlApiReachable(...args),
  ensureRepoRegisteredWithControl: (...args: unknown[]) => ensureRepoRegisteredWithControl(...args),
}));
jest.mock('../src/core/control-lifecycle', () => ({
  startControlAndSync: (...args: unknown[]) => startControlAndSync(...args),
}));

import { defaultEnsureControl } from '../src/core/onboarding';

describe('defaultEnsureControl', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('registers the repo with Mission Control once telemetry brings it up reachable', async () => {
    ensureTelemetryInfrastructure.mockResolvedValue({
      started: true,
      reachable: true,
      apiUrl: 'http://127.0.0.1:3847',
    });

    const result = await defaultEnsureControl({
      startControl: true,
      telemetry: 'on',
      cwd: '/repos/demo',
    });

    expect(result.started).toBe(true);
    expect(ensureRepoRegisteredWithControl).toHaveBeenCalledWith(
      '/repos/demo',
      'http://127.0.0.1:3847',
    );
  });

  it('does not register when Mission Control never becomes reachable', async () => {
    ensureTelemetryInfrastructure.mockResolvedValue({
      started: false,
      reachable: false,
      apiUrl: 'http://127.0.0.1:3847',
      warning: 'not reachable',
    });

    await defaultEnsureControl({ startControl: true, telemetry: 'on', cwd: '/repos/demo' });

    expect(ensureRepoRegisteredWithControl).not.toHaveBeenCalled();
  });

  it('registers when Mission Control was already running and startControl is skipped', async () => {
    ensureTelemetryInfrastructure.mockResolvedValue({ started: false, reachable: false });
    isControlApiReachable.mockResolvedValue(true);

    await defaultEnsureControl({ startControl: false, telemetry: 'on', cwd: '/repos/demo' });

    expect(ensureRepoRegisteredWithControl).toHaveBeenCalledWith(
      '/repos/demo',
      'http://127.0.0.1:3847',
    );
  });

  it('skips registration entirely when telemetry is off', async () => {
    await defaultEnsureControl({ startControl: false, telemetry: 'off', cwd: '/repos/demo' });

    expect(ensureTelemetryInfrastructure).not.toHaveBeenCalled();
    expect(ensureRepoRegisteredWithControl).not.toHaveBeenCalled();
  });
});
