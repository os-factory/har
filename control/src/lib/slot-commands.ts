/** Exact `har env` commands Mission Control offers to copy (#340). */

/** The `har env` commands that move a slot forward, with `--repo` prefilled so they run from anywhere. */
export function slotCommands(repoPath: string, slotId: number, active: boolean): Array<{ label: string; command: string }> {
  const repo = `--repo ${shellQuote(repoPath)}`;
  if (!active) return [{ label: 'Launch', command: `har env launch ${slotId} ${repo}` }];
  return [
    { label: 'Verify', command: `har env verify ${slotId} --full ${repo}` },
    { label: 'Complete', command: `har env complete ${slotId} ${repo}` },
    { label: 'Teardown', command: `har env teardown ${slotId} ${repo}` },
    { label: 'Recover', command: `har env recover ${slotId} ${repo}` },
  ];
}

export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}
