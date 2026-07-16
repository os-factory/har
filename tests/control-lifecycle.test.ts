import {
  CONTROL_CONTAINER_NAME,
  CONTROL_DATA_VOLUME,
  buildDockerRunArgs,
  resolveControlBuildContext,
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

describe('control lifecycle docker run', () => {
  it('resolves control dir beside dist/', () => {
    expect(resolveControlDir()).toMatch(/control$/);
  });

  it('resolves the build context as the package root above control/', () => {
    const context = resolveControlBuildContext();
    expect(resolveControlDir()).toBe(`${context}/control`);
  });

  it('builds detached run args with the named volume and port mapping', () => {
    const args = buildDockerRunArgs({
      imageRef: 'theosfactory/har-control:1.2.3',
      hostPort: 3847,
      detach: true,
    });
    expect(args).toEqual([
      'run',
      '--name',
      CONTROL_CONTAINER_NAME,
      '-d',
      '--restart',
      'unless-stopped',
      '-p',
      '3847:3847',
      '-v',
      `${CONTROL_DATA_VOLUME}:/data`,
      '-e',
      'DATABASE_URL=file:/data/har_control.db',
      'theosfactory/har-control:1.2.3',
    ]);
  });

  it('uses --rm (not -d) for a foreground run and honors a custom host port', () => {
    const args = buildDockerRunArgs({
      imageRef: 'example/har-control:9.9.9',
      hostPort: 4000,
      detach: false,
    });
    expect(args).toContain('--rm');
    expect(args).not.toContain('-d');
    expect(args).toContain('4000:3847');
  });
});
