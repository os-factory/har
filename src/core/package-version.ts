import * as fs from 'fs';
import * as path from 'path';

/** Read @osfactory/har semver from the installed package.json (bundled CLI or source). */
export function getHarPackageVersion(): string {
  if (process.env.HAR_PACKAGE_VERSION) {
    return process.env.HAR_PACKAGE_VERSION;
  }

  const candidates = [
    path.resolve(__dirname, '..', 'package.json'),
    path.resolve(__dirname, '..', '..', 'package.json'),
  ];

  for (const packageJsonPath of candidates) {
    if (!fs.existsSync(packageJsonPath)) continue;
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { version: string };
    return pkg.version;
  }

  throw new Error('Could not resolve @osfactory/har package.json for version lookup');
}
