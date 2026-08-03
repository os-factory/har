import {
  HAR_ENV_EPILOG,
  HAR_ROOT_EPILOG,
  LAUNCH_COMMAND_DESCRIBE,
  LAUNCH_EPILOG,
  LAUNCH_RESUME_DESCRIBE,
} from '../src/cli/help-text';

describe('cli help text', () => {
  it('explains launch base and occupied-slot handling without --replace/--force', () => {
    expect(HAR_ROOT_EPILOG).toContain('main checkout');
    expect(HAR_ROOT_EPILOG).toContain('Occupied slots always block');
    expect(HAR_ROOT_EPILOG).toContain('complete');
    expect(HAR_ROOT_EPILOG).toContain('teardown');
    expect(HAR_ROOT_EPILOG).not.toContain('--replace');
    expect(HAR_ROOT_EPILOG).not.toContain('--force');
    expect(HAR_ENV_EPILOG).toContain('HEAD');
    expect(HAR_ENV_EPILOG).toContain('Always blocked for a fresh launch');
    expect(HAR_ENV_EPILOG).not.toContain('--replace');
    expect(HAR_ENV_EPILOG).not.toContain('--force');
    expect(LAUNCH_COMMAND_DESCRIBE).toContain('HEAD');
    expect(LAUNCH_RESUME_DESCRIBE).toContain('failed');
    expect(LAUNCH_EPILOG).toContain('recover');
    expect(LAUNCH_EPILOG).not.toContain('--replace');
    expect(LAUNCH_EPILOG).not.toContain('--force');
  });
});
