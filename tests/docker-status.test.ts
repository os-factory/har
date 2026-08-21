jest.mock('child_process', () => {
  const actual = jest.requireActual('child_process') as typeof import('child_process');
  return {
    ...actual,
    execFileSync: jest.fn(() => {
      throw new Error('default docker probe is stubbed in unit tests');
    }),
  };
});

import * as childProcess from 'child_process';
import {
  DOCKER_INSTALL_URL,
  describeDockerStatus,
  detectDockerStatus,
  formatDockerRequirementWarning,
  isDockerUsable,
  parseDockerVersion,
  resetDockerStatusCache,
  warnIfDockerUnavailable,
  type DockerProbe,
} from '../src/core/docker-status';

function probe(version: string | null, daemon = false): DockerProbe {
  return { version: () => version, daemon: () => daemon };
}

describe('parseDockerVersion', () => {
  it('extracts the client version', () => {
    expect(parseDockerVersion('Docker version 27.3.1, build ce12230\n')).toBe('27.3.1');
    expect(parseDockerVersion('Docker version 24.0.7')).toBe('24.0.7');
  });

  it('returns undefined for missing or unparseable output', () => {
    expect(parseDockerVersion(null)).toBeUndefined();
    expect(parseDockerVersion('podman is not docker')).toBeUndefined();
  });
});

describe('detectDockerStatus', () => {
  afterEach(() => resetDockerStatusCache());

  it('reports a usable engine when the CLI and daemon respond', () => {
    const status = detectDockerStatus({ probe: probe('Docker version 27.3.1, build ce12230', true) });
    expect(status).toEqual({ cliInstalled: true, daemonRunning: true, version: '27.3.1' });
    expect(isDockerUsable(status)).toBe(true);
  });

  it('reports an installed CLI with a stopped daemon', () => {
    const status = detectDockerStatus({ probe: probe('Docker version 27.3.1', false) });
    expect(status.cliInstalled).toBe(true);
    expect(status.daemonRunning).toBe(false);
    expect(isDockerUsable(status)).toBe(false);
  });

  it('does not probe the daemon when the CLI is missing', () => {
    const daemon = jest.fn(() => true);
    const status = detectDockerStatus({ probe: { version: () => null, daemon } });
    expect(status).toEqual({ cliInstalled: false, daemonRunning: false });
    expect(daemon).not.toHaveBeenCalled();
  });

  it('never caches injected probes (caching applies to the default probe only)', () => {
    const version = jest.fn(() => 'Docker version 27.3.1');
    const daemon = jest.fn(() => true);
    detectDockerStatus({ probe: { version, daemon } });
    detectDockerStatus({ probe: { version, daemon } });
    expect(version).toHaveBeenCalledTimes(2);
  });

  it('memoizes the default probe and re-probes after a cache reset', () => {
    const exec = childProcess.execFileSync as jest.MockedFunction<typeof childProcess.execFileSync>;
    exec.mockImplementation((_file, args) => {
      const flag = Array.isArray(args) ? String(args[0]) : '';
      if (flag === '--version') return 'Docker version 27.3.1, build test\n';
      return '27.3.1\n';
    });
    try {
      const first = detectDockerStatus();
      expect(first).toEqual({ cliInstalled: true, daemonRunning: true, version: '27.3.1' });
      expect(detectDockerStatus()).toBe(first);
      const callsAfterCacheHit = exec.mock.calls.length;
      detectDockerStatus();
      expect(exec.mock.calls.length).toBe(callsAfterCacheHit);

      resetDockerStatusCache();
      const second = detectDockerStatus();
      expect(second).not.toBe(first);
      expect(second).toEqual(first);
      expect(exec.mock.calls.length).toBeGreaterThan(callsAfterCacheHit);
    } finally {
      exec.mockReset();
      exec.mockImplementation(() => {
        throw new Error('default docker probe is stubbed in unit tests');
      });
      resetDockerStatusCache();
    }
  });
});

describe('formatDockerRequirementWarning', () => {
  it('is silent when Docker is usable', () => {
    expect(
      formatDockerRequirementWarning({ cliInstalled: true, daemonRunning: true, version: '27.3.1' }),
    ).toBeNull();
  });

  it('states the requirement and links the installer when Docker is missing', () => {
    const warning = formatDockerRequirementWarning({ cliInstalled: false, daemonRunning: false });
    expect(warning).toContain('Docker is required');
    expect(warning).toContain('Mission Control');
    expect(warning).toContain(DOCKER_INSTALL_URL);
  });

  it('tells the user to start the daemon when only the CLI is present', () => {
    const warning = formatDockerRequirementWarning({ cliInstalled: true, daemonRunning: false });
    expect(warning).toContain('daemon is not responding');
    expect(warning).not.toContain(DOCKER_INSTALL_URL);
  });
});

describe('describeDockerStatus', () => {
  it('summarizes each state for the onboarding summary', () => {
    expect(describeDockerStatus({ cliInstalled: false, daemonRunning: false })).toBe(
      'not installed (required)',
    );
    expect(
      describeDockerStatus({ cliInstalled: true, daemonRunning: false, version: '27.3.1' }),
    ).toBe('installed 27.3.1 but not running');
    expect(
      describeDockerStatus({ cliInstalled: true, daemonRunning: true, version: '27.3.1' }),
    ).toBe('running (27.3.1)');
  });
});

describe('warnIfDockerUnavailable', () => {
  let spy: jest.SpyInstance;

  beforeEach(() => {
    spy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => spy.mockRestore());

  it('logs and returns the warning when Docker is unusable', () => {
    const warning = warnIfDockerUnavailable({ cliInstalled: false, daemonRunning: false });
    expect(warning).toContain('Docker is required');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toContain('Docker is required');
  });

  it('stays quiet when Docker is usable', () => {
    expect(warnIfDockerUnavailable({ cliInstalled: true, daemonRunning: true })).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});
