const spawnSync = jest.fn();
jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  spawnSync: (...args: unknown[]) => spawnSync(...args),
}));

import { startMissionControl } from '../src/core/control-lifecycle';

/** The docker commands startMissionControl ran, as `docker <args>` strings. */
const dockerCalls = (): string[] =>
  spawnSync.mock.calls
    .filter(([command]) => command === 'docker')
    .map(([, args]) => (args as string[]).join(' '));

describe('startMissionControl: the default container while the CLI targets another', () => {
  const originalUrl = process.env.HAR_CONTROL_API_URL;
  const originalImage = process.env.HAR_CONTROL_IMAGE;

  beforeEach(() => {
    spawnSync.mockReset();
    // `docker ps -aq -f name=^har-control$` finds the user's container; everything else succeeds.
    spawnSync.mockImplementation((_command: string, args: string[]) =>
      args[0] === 'ps' ? { status: 0, stdout: 'abc123\n' } : { status: 0, stdout: '' },
    );
    process.env.HAR_CONTROL_IMAGE = 'theosfactory/har-control';
  });

  afterEach(() => {
    if (originalUrl === undefined) delete process.env.HAR_CONTROL_API_URL;
    else process.env.HAR_CONTROL_API_URL = originalUrl;
    if (originalImage === undefined) delete process.env.HAR_CONTROL_IMAGE;
    else process.env.HAR_CONTROL_IMAGE = originalImage;
  });

  it('leaves the existing default container alone and says why', async () => {
    // A sandboxed CLI pointed at a second Mission Control that is not up yet.
    process.env.HAR_CONTROL_API_URL = 'http://localhost:13850';

    const result = await startMissionControl({ detach: true, quiet: true });

    expect(result.code).not.toBe(0);
    expect(result.reason).toMatch(/har-control/);
    expect(dockerCalls().filter((call) => call.startsWith('rm') || call.startsWith('run'))).toEqual([]);
  });

  it('still replaces the default container when the CLI targets it', async () => {
    process.env.HAR_CONTROL_API_URL = 'http://127.0.0.1:3847/';

    const result = await startMissionControl({ detach: true, quiet: true });

    expect(result.code).toBe(0);
    expect(dockerCalls()).toEqual(
      expect.arrayContaining(['rm -f har-control', expect.stringMatching(/^run --name har-control .*-p 3847:3847/)]),
    );
  });
});
