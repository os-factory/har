import {
  ENV_LIFECYCLE_EPILOG,
  HAR_TYPICAL_WORKFLOW_EPILOG,
  LAUNCH_COMMAND_DESCRIBE,
  LAUNCH_LIFECYCLE_EPILOG,
} from '../src/cli/lifecycle-help';

describe('lifecycle help copy', () => {
  it('teaches the typical launch → verify → complete workflow', () => {
    expect(HAR_TYPICAL_WORKFLOW_EPILOG).toContain('har env launch');
    expect(HAR_TYPICAL_WORKFLOW_EPILOG).toContain('har env verify');
    expect(HAR_TYPICAL_WORKFLOW_EPILOG).toContain('har env complete');
    expect(HAR_TYPICAL_WORKFLOW_EPILOG).toContain('--replace');
    expect(HAR_TYPICAL_WORKFLOW_EPILOG).toContain('does NOT select main');
  });

  it('contrasts env lifecycle subcommands', () => {
    for (const term of ['preflight', 'launch', 'recover', 'complete', 'teardown', 'status']) {
      expect(ENV_LIFECYCLE_EPILOG).toContain(term);
    }
    expect(ENV_LIFECYCLE_EPILOG).toContain('prefer complete or teardown');
  });

  it('documents launch base, purpose, and replace semantics', () => {
    expect(LAUNCH_COMMAND_DESCRIBE).toContain('main-checkout HEAD');
    expect(LAUNCH_LIFECYCLE_EPILOG).toContain('--purpose');
    expect(LAUNCH_LIFECYCLE_EPILOG).toContain('--replace');
    expect(LAUNCH_LIFECYCLE_EPILOG).toContain('Does NOT mean');
    expect(LAUNCH_LIFECYCLE_EPILOG).toContain('does NOT select main');
    expect(LAUNCH_LIFECYCLE_EPILOG).toContain('--resume');
  });
});
