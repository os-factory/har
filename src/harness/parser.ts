import * as fs from 'fs';
import { readManifest } from './manifest';

export function harnessExists(repoPath: string): boolean {
  return fs.existsSync(`${repoPath}/.har/setup-infra.sh`);
}

export { readManifest };
