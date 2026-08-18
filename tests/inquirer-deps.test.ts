import * as fs from 'fs';
import * as path from 'path';

const lock = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'package-lock.json'), 'utf8'),
) as { packages: Record<string, unknown> };

function installedPackages(name: string): string[] {
  const suffix = `node_modules/${name}`;
  return Object.keys(lock.packages).filter((key) => key === suffix || key.endsWith(`/${suffix}`));
}

describe('inquirer dependency tree', () => {
  it('does not pull the vulnerable tmp package (GHSA-52f5-9888-hmc6, GHSA-ph9p-34f9-6g65)', () => {
    expect(installedPackages('tmp')).toEqual([]);
  });

  it('does not pull the abandoned external-editor package', () => {
    expect(installedPackages('external-editor')).toEqual([]);
  });
});
