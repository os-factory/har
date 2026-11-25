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

/**
 * Checks the Factory Commits proof on a commit. Mission Control only shows the
 * proof it received; the commit's notes and trailers are checked by har.
 */
export function proofVerifyCommand(repoPath: string | null, commitSha: string): string {
  return `har proof verify ${commitSha}${repoPath ? ` --repo ${shellQuote(repoPath)}` : ''}`;
}

export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}
