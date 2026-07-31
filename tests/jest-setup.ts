import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Keep unit tests from writing to the developer's real ~/.har/repos.json.
 * Spawned CLI subprocesses inherit this via process.env.
 */
const harHome = fs.mkdtempSync(path.join(os.tmpdir(), 'har-jest-home-'));
process.env.HAR_CONTROL_REGISTRY_PATH = path.join(harHome, 'repos.json');

afterAll(() => {
  fs.rmSync(harHome, { recursive: true, force: true });
  delete process.env.HAR_CONTROL_REGISTRY_PATH;
});
