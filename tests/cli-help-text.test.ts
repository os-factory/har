import {
  HAR_ENV_EPILOG,
  HAR_ROOT_EPILOG,
  LAUNCH_COMMAND_DESCRIBE,
  LAUNCH_EPILOG,
  LAUNCH_REPLACE_DESCRIBE,
} from '../src/cli/help-text';

describe('cli help text', () => {
  it('explains launch base and replace vs complete', () => {
    expect(HAR_ROOT_EPILOG).toContain('main checkout');
    expect(HAR_ROOT_EPILOG).toContain('--replace');
    expect(HAR_ROOT_EPILOG).toContain('complete');
    expect(HAR_ENV_EPILOG).toContain('HEAD of --repo');
    expect(LAUNCH_COMMAND_DESCRIBE).toContain('HEAD');
    expect(LAUNCH_REPLACE_DESCRIBE).toContain('does not choose main');
    expect(LAUNCH_EPILOG).toContain('recover');
  });
});
