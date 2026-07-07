import {
  buildDockerComposeEnv,
  resolveControlComposeFiles,
  resolveControlDir,
} from '../src/core/control-lifecycle';
import {
  DEFAULT_CONTROL_IMAGE,
  getControlImageName,
  getControlImageRef,
  getControlImageTag,
} from '../src/core/control-image';
import { getHarPackageVersion } from '../src/core/package-version';

describe('package version', () => {
  const originalVersion = process.env.HAR_PACKAGE_VERSION;

  afterEach(() => {
    if (originalVersion === undefined) {
      delete process.env.HAR_PACKAGE_VERSION;
    } else {
      process.env.HAR_PACKAGE_VERSION = originalVersion;
    }
  });

  it('reads version from package.json', () => {
    expect(getHarPackageVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('respects HAR_PACKAGE_VERSION override', () => {
    process.env.HAR_PACKAGE_VERSION = '9.8.7';
    expect(getHarPackageVersion()).toBe('9.8.7');
  });
});

describe('control image', () => {
  const envKeys = ['HAR_CONTROL_IMAGE', 'HAR_CONTROL_IMAGE_TAG', 'HAR_PACKAGE_VERSION'] as const;
  const original: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of envKeys) {
      original[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (original[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original[key];
      }
    }
  });

  it('defaults image name and tag to CLI version', () => {
    expect(getControlImageName()).toBe(DEFAULT_CONTROL_IMAGE);
    expect(DEFAULT_CONTROL_IMAGE).toBe('theosfactory/har-control');
    expect(getControlImageTag()).toBe(getHarPackageVersion());
    expect(getControlImageRef()).toBe(`${DEFAULT_CONTROL_IMAGE}:${getHarPackageVersion()}`);
  });

  it('allows env overrides', () => {
    process.env.HAR_CONTROL_IMAGE = 'example/har-control';
    process.env.HAR_CONTROL_IMAGE_TAG = '1.2.3';
    expect(getControlImageRef()).toBe('example/har-control:1.2.3');
  });
});

describe('control lifecycle compose', () => {
  const originalBuild = process.env.HAR_CONTROL_BUILD;

  afterEach(() => {
    if (originalBuild === undefined) {
      delete process.env.HAR_CONTROL_BUILD;
    } else {
      process.env.HAR_CONTROL_BUILD = originalBuild;
    }
  });

  it('resolves control dir beside dist/', () => {
    expect(resolveControlDir()).toMatch(/control$/);
  });

  it('uses pull-only compose by default', () => {
    delete process.env.HAR_CONTROL_BUILD;
    const files = resolveControlComposeFiles();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/docker-compose\.yml$/);
  });

  it('merges build override when requested', () => {
    const files = resolveControlComposeFiles({ build: true });
    expect(files).toHaveLength(2);
    expect(files[1]).toMatch(/docker-compose\.build\.yml$/);
  });

  it('passes coupled image env to docker compose', () => {
    process.env.HAR_CONTROL_IMAGE_TAG = '0.1.0';
    const env = buildDockerComposeEnv();
    expect(env.HAR_CONTROL_IMAGE).toBe(DEFAULT_CONTROL_IMAGE);
    expect(env.HAR_CONTROL_IMAGE_TAG).toBe('0.1.0');
  });
});
