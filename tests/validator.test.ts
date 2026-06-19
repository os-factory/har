import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scaffoldHarnessBoilerplate } from '../src/harness/generator';
import { validateHarness } from '../src/harness/validator';

describe('validateHarness', () => {
  it('reports missing required files', () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'har-validate-'));
    const result = validateHarness(repoPath);
    expect(result.pass).toBe(false);
    expect(result.issues.some((issue) => issue.file === '.har')).toBe(true);
  });

  it('passes after scaffolding boilerplate into a temp repo', () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'har-validate-scaffold-'));
    fs.cpSync(path.join(__dirname, 'fixtures', 'node-react-pg'), repoPath, { recursive: true });
    scaffoldHarnessBoilerplate(repoPath, { force: true });
    const result = validateHarness(repoPath);
    expect(result.pass).toBe(true);
  });
});
