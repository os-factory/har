import { describe, expect, it } from 'vitest';
import { shellQuote, slotCommands } from './slot-commands';

describe('slotCommands (#340)', () => {
  it('prefills --repo so the command runs from any directory', () => {
    expect(slotCommands('/home/me/app', 3, true).map((c) => c.command)).toEqual([
      'har env verify 3 --full --repo /home/me/app',
      'har env complete 3 --repo /home/me/app',
      'har env teardown 3 --repo /home/me/app',
      'har env recover 3 --repo /home/me/app',
    ]);
    expect(slotCommands('/home/me/app', 1, false)).toEqual([{ label: 'Launch', command: 'har env launch 1 --repo /home/me/app' }]);
  });
  it('quotes paths that need it', () => {
    expect(shellQuote('/home/me/my app')).toBe("'/home/me/my app'");
    expect(shellQuote("/it's")).toBe("'/it'\\''s'");
  });
});
