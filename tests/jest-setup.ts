import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AGENT_SESSION_ENV } from '../packages/schemas/src/session-attribution';

/**
 * Keep unit tests from writing to the developer's real ~/.har/repos.json.
 * Spawned CLI subprocesses inherit this via process.env.
 */
const harHome = fs.mkdtempSync(path.join(os.tmpdir(), 'har-jest-home-'));
process.env.HAR_CONTROL_REGISTRY_PATH = path.join(harHome, 'repos.json');
// Nor read the developer's saved `har control sync` selection, which scopes syncs.
process.env.HAR_CONTROL_SYNC_SELECTION_PATH = path.join(harHome, 'sync-selection.json');
// Nor read (or write) the developer's real HAR HQ connection.
process.env.HAR_PORTAL_TARGETS_PATH = path.join(harHome, 'portal-targets.json');
// ...nor migrate the developer's legacy ~/.har/credentials.json into it.
process.env.HAR_CREDENTIALS_PATH = path.join(harHome, 'credentials.json');
// Nor send verification spans to the developer's real OTLP destinations.
process.env.HAR_DESTINATIONS_DIR = path.join(harHome, 'destinations');
// Nor open or close segments in the developer's real session context files (ADR 0004).
process.env.HAR_SESSIONS_DIR = path.join(harHome, 'sessions');
// Nor rewrite the developer's real otel-hook config when a destination changes.
process.env.HAR_OTEL_HOOKS_HOME = path.join(harHome, 'otel-hooks');

afterAll(() => {
  fs.rmSync(harHome, { recursive: true, force: true });
  delete process.env.HAR_CONTROL_REGISTRY_PATH;
  delete process.env.HAR_CONTROL_SYNC_SELECTION_PATH;
  delete process.env.HAR_PORTAL_TARGETS_PATH;
  delete process.env.HAR_CREDENTIALS_PATH;
  delete process.env.HAR_DESTINATIONS_DIR;
  delete process.env.HAR_SESSIONS_DIR;
  delete process.env.HAR_OTEL_HOOKS_HOME;
});

// Tests run inside coding agents: never let the developer's own agent session
// (ADR 0003) leak into launch / teardown bindings recorded by tests.
for (const name of Object.values(AGENT_SESSION_ENV)) {
  delete process.env[name];
}
