const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Factory line board (#305).
 *
 * The board is a view over the installed line bundle plus records Mission
 * Control already has. Two things it must never do: offer to install a line
 * (that is `har line add`), and draw line gate stages as if they belonged to
 * the verify pipeline — they are off it by design, and reporting them as
 * missing verification stages would call a healthy pipeline broken.
 *
 * A fixture repository is registered so the board renders real content instead
 * of skipping on whatever happens to be synced into this environment.
 */

let fixtureDir;
let repoId;

function writeFixtureRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-line-e2e-'));
  fs.mkdirSync(path.join(dir, '.har', 'lines', 'demo-line'), { recursive: true });

  fs.writeFileSync(
    path.join(dir, '.har', 'stages.json'),
    JSON.stringify({
      version: '1',
      // The line's stages are registered and deliberately absent here.
      verificationStages: ['typecheck', 'unit-tests'],
      stages: [
        { id: 'typecheck', kind: 'test' },
        { id: 'unit-tests', kind: 'test' },
        { id: 'demo-s1', kind: 'test' },
        { id: 'demo-s2', kind: 'test' },
      ],
    }),
  );

  fs.writeFileSync(
    path.join(dir, '.har', 'lines.json'),
    JSON.stringify({
      version: '1',
      lines: [
        {
          id: 'demo-line',
          source: 'git',
          spec: 'github:acme/demo-line',
          stageIds: ['demo-s1', 'demo-s2'],
          programPath: '.har/lines/demo-line/line.json',
          installedAt: '2026-08-01T00:00:00.000Z',
        },
      ],
    }),
  );

  fs.writeFileSync(
    path.join(dir, '.har', 'lines', 'demo-line', 'line.json'),
    JSON.stringify({
      contractVersion: 1,
      id: 'demo-line',
      title: 'Demo line',
      description: 'Two stations and a gate that only grows.',
      skills: [{ id: 'factory-line', role: 'orchestrator' }],
      mcp: [{ name: 'github', why: 'tracker', required: false }],
      plugins: [],
      stations: [
        { id: 'S1', title: 'First station', work: { source: 'github', ids: ['42'] } },
        { id: 'S2', title: 'Second station' },
      ],
      gate: {
        cumulative: true,
        optInEnv: null,
        stages: [
          { id: 'demo-s1', fromStation: 'S1', tier: 'full' },
          { id: 'demo-s2', fromStation: 'S2', tier: 'full' },
        ],
      },
      extraStages: [],
      handoff: { autonomousShip: false },
      prototypeNotes: [],
    }),
  );

  return dir;
}

test.beforeAll(async ({ request }) => {
  fixtureDir = writeFixtureRepo();
  const response = await request.post('/api/repos', {
    data: { path: fixtureDir, force: true },
  });
  expect(response.ok()).toBeTruthy();
  repoId = (await response.json()).id;
});

test.afterAll(async ({ request }) => {
  if (repoId) await request.delete(`/api/repos/${repoId}`).catch(() => {});
  if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
});

test.describe('Factory line board', () => {
  test('draws stations, the cumulative gate, and the off-verify callout', async ({ page }) => {
    await page.goto(`/repos/${repoId}/lines`);

    await expect(page.getByTestId('line-board-page')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Factory lines' })).toBeVisible();
    await expect(page.getByTestId('line-board-demo-line')).toBeVisible();

    // The traveler: both stations visible, earlier ones never hidden.
    await expect(page.getByTestId('line-station-S1')).toBeVisible();
    await expect(page.getByTestId('line-station-S2')).toBeVisible();

    // The ratchet is legible: S2 requires S1's stage as well as its own.
    await expect(page.getByTestId('line-station-S2')).toContainText('demo-s1, demo-s2');
    await expect(page.getByTestId('line-station-S1')).toContainText('0/1 gate stages green');
    await expect(page.getByTestId('line-station-S2')).toContainText('0/2 gate stages green');

    // Nothing has run yet, so S1 is next.
    await expect(page.getByTestId('line-station-S1')).toContainText('next');

    // The verify pipeline is healthy: line stages are off it on purpose.
    await expect(page.getByText(/none on the verify plan/i)).toBeVisible();
    await expect(page.getByText(/har env verify --full/)).toBeVisible();

    // Declared, never installed — and no install affordance anywhere.
    await expect(page.getByText(/never installs skills or MCP servers/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /install/i })).toHaveCount(0);
  });

  test('links to the board from the repository page', async ({ page }) => {
    await page.goto(`/repos/${repoId}`);
    const link = page.getByTestId('repo-lines-link');
    await expect(link).toBeVisible();
    await link.click();
    await page.waitForURL(/\/repos\/[^/]+\/lines$/, { timeout: 10_000 });
    await expect(page.getByTestId('line-board-demo-line')).toBeVisible();
  });

  test('shows an empty state that points at the CLI, not an install button', async ({
    page,
    request,
  }) => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-line-e2e-empty-'));
    fs.mkdirSync(path.join(emptyDir, '.har'), { recursive: true });
    const response = await request.post('/api/repos', {
      data: { path: emptyDir, force: true },
    });
    const emptyId = (await response.json()).id;

    await page.goto(`/repos/${emptyId}/lines`);

    const empty = page.getByTestId('line-board-empty');
    await expect(empty).toBeVisible();
    await expect(empty).toContainText('har line add');
    await expect(empty).toContainText('without changing routine verification');
    await expect(page.getByRole('button', { name: /install/i })).toHaveCount(0);

    await request.delete(`/api/repos/${emptyId}`).catch(() => {});
    fs.rmSync(emptyDir, { recursive: true, force: true });
  });
});
