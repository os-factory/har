import {
  CONTROL_CONTAINER_NAME,
  CONTROL_DATA_VOLUME,
  buildDockerRunArgs,
  controlOtlpEndpoints,
  planControlOtlpGrpcPort,
  resolveControlOtlpGrpcHostPort,
  shouldUpgradeControlImage,
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

  it('publishes the OTLP/gRPC port when given', () => {
    const args = buildDockerRunArgs({ imageRef: 'img:1', hostPort: 3847, detach: true, otlpGrpcHostPort: 14317 });
    expect(args.slice(6, 10)).toEqual(['-p', '3847:3847', '-p', '14317:4317']);
    const without = buildDockerRunArgs({ imageRef: 'img:1', hostPort: 3847, detach: true, otlpGrpcHostPort: null });
    expect(without.join(' ')).not.toContain(':4317');
  });

  it('mounts no destinations and adds no host-gateway entry: Mission Control no longer forwards', () => {
    const args = buildDockerRunArgs({ imageRef: 'img:1', hostPort: 3847, detach: true }).join(' ');
    expect(args).not.toContain('host.docker.internal');
    expect(args).not.toContain('destinations');
    expect(args).not.toContain('HAR_DESTINATIONS_DIR');
  });
});

describe('Mission Control OTLP/gRPC port', () => {
  it('defaults to 4317, honors HAR_CONTROL_OTLP_GRPC_PORT, and 0/off disables it', () => {
    expect(resolveControlOtlpGrpcHostPort({})).toBe(4317);
    expect(resolveControlOtlpGrpcHostPort({ HAR_CONTROL_OTLP_GRPC_PORT: '14317' })).toBe(14317);
    expect(resolveControlOtlpGrpcHostPort({ HAR_CONTROL_OTLP_GRPC_PORT: 'off' })).toBeNull();
    expect(resolveControlOtlpGrpcHostPort({ HAR_CONTROL_OTLP_GRPC_PORT: '0' })).toBeNull();
  });

  it('skips publishing a busy host port with a hint instead of failing', () => {
    const plan = planControlOtlpGrpcPort({}, (port) => port === 4317);
    expect(plan.hostPort).toBeNull();
    expect(plan.hint).toContain('port 4317 is in use');
    expect(plan.hint).toContain('HAR_CONTROL_OTLP_GRPC_PORT');
    expect(planControlOtlpGrpcPort({}, () => false)).toEqual({ hostPort: 4317 });
    expect(planControlOtlpGrpcPort({ HAR_CONTROL_OTLP_GRPC_PORT: 'off' }, () => true)).toEqual({ hostPort: null });
  });

  it('names both endpoints for status output', () => {
    expect(controlOtlpEndpoints('http://localhost:3847/', 4317)).toEqual({
      http: 'http://localhost:3847/api/otel',
      grpc: 'grpc://localhost:4317',
    });
    expect(controlOtlpEndpoints('http://localhost:3847', null)).toEqual({ http: 'http://localhost:3847/api/otel' });
  });
});

describe('shouldUpgradeControlImage', () => {
  const expected = `${DEFAULT_CONTROL_IMAGE}:1.23.0`;

  it('upgrades a container on an older released image', () => {
    expect(shouldUpgradeControlImage(`${DEFAULT_CONTROL_IMAGE}:1.16.0`, expected, {})).toBe(true);
  });

  it('leaves a container already on the expected image', () => {
    expect(shouldUpgradeControlImage(expected, expected, {})).toBe(false);
  });

  it('leaves a container started from another image or a custom tag', () => {
    expect(shouldUpgradeControlImage('my-registry/har-control:1.16.0', expected, {})).toBe(false);
    expect(shouldUpgradeControlImage(`${DEFAULT_CONTROL_IMAGE}:dev`, expected, {})).toBe(false);
  });

  it('leaves the container alone while an image override is set', () => {
    const running = `${DEFAULT_CONTROL_IMAGE}:1.16.0`;
    expect(shouldUpgradeControlImage(running, expected, { HAR_CONTROL_IMAGE_TAG: '1.16.0' })).toBe(false);
    expect(shouldUpgradeControlImage(running, expected, { HAR_CONTROL_IMAGE: 'x/har-control' })).toBe(false);
  });

  it('leaves the default container alone while the CLI targets another Mission Control', () => {
    const running = `${DEFAULT_CONTROL_IMAGE}:1.16.0`;
    expect(shouldUpgradeControlImage(running, expected, { HAR_CONTROL_API_URL: 'http://127.0.0.1:13847' })).toBe(false);
    expect(shouldUpgradeControlImage(running, expected, { HAR_CONTROL_API_URL: 'http://10.0.0.5:3847' })).toBe(false);
    expect(shouldUpgradeControlImage(running, expected, { HAR_CONTROL_API_URL: 'http://localhost:3847' })).toBe(true);
  });

  it('treats any spelling of the default URL as the default container', () => {
    const running = `${DEFAULT_CONTROL_IMAGE}:1.16.0`;
    for (const url of ['http://127.0.0.1:3847', 'http://localhost:3847/', 'http://[::1]:3847']) {
      expect(shouldUpgradeControlImage(running, expected, { HAR_CONTROL_API_URL: url })).toBe(true);
    }
  });
});
