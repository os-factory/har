import { execFileSync, spawn, type ChildProcess } from 'child_process';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { type UsageInvariantReport } from '../packages/schemas/src/usage-invariants';

/**
 * Usage integrity, end to end (FE-2058; station S1 of the `usage-integrity`
 * factory line). Mission Control runs from source (`next dev`, fresh SQLite),
 * the built CLI drives real repositories, slots and worktrees in a sandbox
 * HOME, and `har control sync` posts to Mission Control. Sessions are
 * synthetic OTLP shaped like otel-hook with os-factory/otel-hook#42 (place
 * evidence) and Claude Code's `api_request` logs (usage). The usage
 * invariants must hold on Mission Control, before and after a resend.
 *
 * No model, no Docker. Opt-in:
 *   npm run build && HAR_USAGE_E2E=1 npx jest tests/usage-integrity.e2e.test.ts
 */

const ROOT = path.resolve(__dirname, '..');
const CONTROL = path.join(ROOT, 'control');
const HAR_BIN = path.join(ROOT, 'dist', 'index.js');
const run = process.env.HAR_USAGE_E2E === '1' ? describe : describe.skip;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

/**
 * otel-hook's own opaque id of a path. The package is ESM-only, so the id is
 * derived by a child Node run from `control/`, where it is installed.
 */
const otelIds = new Map<string, string>();
function otelId(kind: 'working-directory' | 'git-root', absolutePath: string): string {
  const key = `${kind}\0${absolutePath}`;
  if (!otelIds.has(key)) {
    const script =
      "import { createPrivacyService, DEFAULT_PRIVACY_POLICY, deriveWorkspaceIdentity } from '@osfactory/otel-hook/privacy';" +
      'const [kind, absolutePath] = process.argv.slice(1);' +
      'process.stdout.write(deriveWorkspaceIdentity(createPrivacyService(DEFAULT_PRIVACY_POLICY), { kind, absolutePath }).workspaceId);';
    const id = execFileSync(
      process.execPath,
      ['--input-type=module', '-e', script, kind, absolutePath],
      {
        cwd: CONTROL,
        encoding: 'utf8',
      },
    );
    otelIds.set(key, id);
  }
  return otelIds.get(key)!;
}

const attrs = (map: Record<string, string | number>) =>
  Object.entries(map).map(([key, value]) => ({
    key,
    value: typeof value === 'number' ? { intValue: value } : { stringValue: value },
  }));

const sid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const S = {
  main: sid(1),
  worktree: sid(2),
  slot: sid(3),
  moves: sid(4),
  parallelA: sid(5),
  parallelB: sid(6),
  twoRepos: sid(7),
  nested: sid(8),
  relaunch: sid(9),
  crossRepo: sid(10),
};

run(
  'usage integrity end to end: Mission Control from source → har control sync',
  () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'har-usage-e2e-'));
    const home = path.join(base, 'home');
    const repoA = path.join(base, 'a');
    const nested = path.join(repoA, 'nested');
    const repoB = path.join(base, 'b');
    const wt1 = path.join(base, 'a-wt-feat');
    const wt2 = path.join(base, 'a-wt-feat2');
    let mc: ChildProcess | null = null;
    let mcUrl = '';
    let clock = Date.now() - 600_000;
    /** Strictly increasing event time, never in the future. */
    const tick = () => (clock += 1_000);

    const env = () => ({
      ...process.env,
      HOME: home,
      HAR_TELEMETRY: 'on',
      // jest sets NODE_ENV=test, and the CLI skips transcript harvest under it.
      NODE_ENV: 'production',
      HAR_CONTROL_API_URL: mcUrl,
      HAR_CONTROL_IMAGE: 'har-usage-e2e/blocked:none',
      HAR_SKIP_TELEMETRY_POSTINSTALL: '1',
      GIT_AUTHOR_NAME: 'e2e',
      GIT_AUTHOR_EMAIL: 'e2e@example.com',
      GIT_COMMITTER_NAME: 'e2e',
      GIT_COMMITTER_EMAIL: 'e2e@example.com',
    });
    const har = (cwd: string, ...args: string[]) =>
      execFileSync('node', [HAR_BIN, ...args], {
        cwd,
        env: env(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 240_000,
      });
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
        cwd,
        env: env(),
        encoding: 'utf8',
      });
    const syncAll = (...flags: string[]) => {
      for (const repo of [repoA, repoB, nested])
        har(repo, 'control', 'sync', '--api-url', mcUrl, ...flags);
    };
    const slotDir = (repo: string, slot: number) =>
      (
        JSON.parse(
          fs.readFileSync(path.join(repo, '.har', 'slots', `agent-${slot}.json`), 'utf8'),
        ) as { workDir: string }
      ).workDir;

    async function api<T>(p: string, body?: unknown): Promise<T> {
      const init = body
        ? {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }
        : undefined;
      let response: Response | null = null;
      // next dev drops idle keep-alive sockets: retry a request that met one.
      for (let attempt = 0; !response; attempt++) {
        response = await fetch(`${mcUrl}${p}`, init).catch((err) => {
          if (attempt >= 3) throw err;
          return new Promise<null>((r) => setTimeout(() => r(null), 500));
        });
      }
      if (!response.ok) throw new Error(`${p}: ${response.status} ${await response.text()}`);
      return (await response.json()) as T;
    }

    async function otlp(signal: 'traces' | 'logs', body: unknown, label: string) {
      const { har: result } = await api<{ har: { accepted: number; reasons?: string[] } }>(
        `/api/otel/v1/${signal}`,
        body,
      );
      expect({ label, accepted: result.accepted, reasons: result.reasons ?? [] }).toMatchObject({
        accepted: 1,
      });
    }

    /**
     * An otel-hook span: a prompt in the session's cwd, or a tool event on a
     * target worktree, with the git-root ids of the worktree and of its
     * repository's main checkout and the worktree's kind.
     */
    async function hookSpan(
      sessionId: string,
      cwd: string,
      target?: { worktree: string; mainCheckout: string; branch: string },
    ) {
      const t = BigInt(tick()) * 1_000_000n;
      const targetAttributes: Record<string, string> = target
        ? {
            'gen_ai.tool.name': 'Edit',
            'otelhook.target.source': 'tool-path',
            'otelhook.target.workspace.id': otelId('git-root', target.worktree),
            'otelhook.target.repository.id': otelId('git-root', target.mainCheckout),
            'otelhook.target.worktree.kind':
              target.worktree === target.mainCheckout ? 'main' : 'linked',
            'otelhook.target.branch': target.branch,
          }
        : {};
      const span = {
        traceId: randomBytes(16).toString('hex'),
        spanId: randomBytes(8).toString('hex'),
        name: target ? 'tool.start' : 'prompt',
        kind: 1,
        startTimeUnixNano: `${t}`,
        endTimeUnixNano: `${t + 1_000_000n}`,
        attributes: attrs({
          'session.id': sessionId,
          'otelhook.session.id': sessionId,
          'gen_ai.conversation.id': sessionId,
          'otelhook.provider.id': 'claude-code',
          'otelhook.workspace.id': otelId('working-directory', cwd),
          'otelhook.event.type': target ? 'tool.end' : 'prompt.submitted',
          ...targetAttributes,
        }),
      };
      const resource = {
        attributes: attrs({ 'service.name': 'otel-hook', 'otelhook.provider.id': 'claude-code' }),
      };
      await otlp(
        'traces',
        { resourceSpans: [{ resource, scopeSpans: [{ spans: [span] }] }] },
        `span ${sessionId}`,
      );
    }

    /** Claude Code's native `api_request` log: one billed request. Returns its time. */
    async function apiRequest(
      sessionId: string,
      requestId: string,
      input: number,
      output: number,
      cacheRead: number,
      cost: number,
    ) {
      const ms = tick();
      const record = {
        timeUnixNano: `${BigInt(ms) * 1_000_000n}`,
        body: { stringValue: 'claude_code.api_request' },
        attributes: attrs({
          'event.name': 'api_request',
          'event.timestamp': new Date(ms).toISOString(),
          'session.id': sessionId,
          request_id: requestId,
          model: 'claude-opus-5-5',
          input_tokens: input,
          output_tokens: output,
          cache_read_tokens: cacheRead,
          cache_creation_tokens: 0,
          cost_usd: cost,
        }),
      };
      const resource = { attributes: attrs({ 'service.name': 'claude-code' }) };
      await otlp(
        'logs',
        { resourceLogs: [{ resource, scopeLogs: [{ logRecords: [record] }] }] },
        `request ${requestId}`,
      );
      return ms;
    }

    /** A session's Claude Code transcript, as `har control sync` harvests it from `~/.claude/projects`. */
    function writeTranscript(
      sessionId: string,
      launchCwd: string,
      requests: Array<{ requestId: string; at: number; cwd: string; input: number }>,
    ) {
      const dir = path.join(home, '.claude', 'projects', launchCwd.replace(/[/.]/g, '-'));
      fs.mkdirSync(dir, { recursive: true });
      const lines = requests.map(({ requestId, at, cwd, input }) =>
        JSON.stringify({
          type: 'assistant',
          sessionId,
          cwd,
          timestamp: new Date(at).toISOString(),
          requestId,
          message: {
            id: `msg_${requestId}`,
            model: 'claude-opus-5-5',
            usage: {
              input_tokens: input,
              output_tokens: 900,
              cache_read_input_tokens: 14_000,
              cache_creation_input_tokens: 0,
            },
          },
        }),
      );
      fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), lines.join('\n') + '\n');
    }

    function initRepo(repo: string) {
      fs.mkdirSync(repo, { recursive: true });
      git(repo, 'init', '-q', '-b', 'main');
      fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
      if (repo === repoA) fs.writeFileSync(path.join(repo, '.gitignore'), 'nested/\n');
      git(repo, 'add', '-A');
      git(repo, 'commit', '-qm', 'init');
      har(
        repo,
        'env',
        'init',
        '--profile',
        'cli',
        '--yes',
        '--no-cursor-rule',
        '--no-agents',
        '--commit-gate',
        'never',
      );
      git(repo, 'add', '-A');
      git(repo, 'commit', '-qm', 'har');
      har(repo, 'control', 'register', '--repo', repo, '--api-url', mcUrl);
    }

    beforeAll(async () => {
      if (!fs.existsSync(HAR_BIN)) throw new Error('build the CLI first: npm run build');
      fs.mkdirSync(home, { recursive: true });
      const databaseUrl = `file:${path.join(base, 'mc.db')}`;
      execFileSync('npx', ['prisma', 'db', 'push'], {
        cwd: CONTROL,
        env: { ...process.env, DATABASE_URL: databaseUrl },
        stdio: 'ignore',
      });
      const mcPort = await freePort();
      mcUrl = `http://127.0.0.1:${mcPort}`;
      const log = fs.openSync(path.join(base, 'mc.log'), 'a');
      mc = spawn('npx', ['next', 'dev', '--port', String(mcPort)], {
        cwd: CONTROL,
        env: { ...process.env, DATABASE_URL: databaseUrl, NEXT_TELEMETRY_DISABLED: '1' },
        stdio: ['ignore', log, log],
        detached: true,
      });
      for (let i = 0; i < 120; i++) {
        const up = await fetch(`${mcUrl}/api/health`).then(
          (r) => r.ok,
          () => false,
        );
        if (up) break;
        await new Promise((r) => setTimeout(r, 1_000));
      }

      // A with two plain worktrees and two slots, B with one slot, a repository nested inside A.
      initRepo(repoA);
      initRepo(repoB);
      initRepo(nested);
      git(repoA, 'worktree', 'add', '-q', '-b', 'feat', wt1);
      git(repoA, 'worktree', 'add', '-q', '-b', 'feat2', wt2);
      har(repoA, 'env', 'launch', '1');
      har(repoA, 'env', 'launch', '2');
      har(repoB, 'env', 'launch', '1');
      syncAll();
    }, 600_000);

    afterAll(() => {
      if (mc?.pid) process.kill(-mc.pid, 'SIGTERM');
      if (process.env.HAR_USAGE_E2E_KEEP === '1') process.stderr.write(`kept ${base}\n`);
      else fs.rmSync(base, { recursive: true, force: true });
    });

    it('drives every place a session can be, and syncs', async () => {
      const slot2 = slotDir(repoA, 2);
      await hookSpan(S.main, repoA);
      await apiRequest(S.main, 'req_main_1', 10, 100, 5_000, 0.05);
      await apiRequest(S.main, 'req_main_2', 12, 120, 6_000, 0.06);
      // A plain (non-slot) worktree.
      await hookSpan(S.worktree, wt1);
      await apiRequest(S.worktree, 'req_wt_1', 20, 200, 7_000, 0.07);
      await hookSpan(S.slot, slotDir(repoA, 1));
      await apiRequest(S.slot, 'req_slot_1', 30, 300, 8_000, 0.08);
      // The main checkout, then a tool event in a linked worktree mid-session.
      await hookSpan(S.moves, repoA);
      await apiRequest(S.moves, 'req_moves_main', 40, 400, 9_000, 0.09);
      await hookSpan(S.moves, repoA, { worktree: wt1, mainCheckout: repoA, branch: 'feat' });
      await apiRequest(S.moves, 'req_moves_wt', 41, 410, 9_100, 0.091);
      await hookSpan(S.parallelA, wt1);
      await hookSpan(S.parallelB, wt2);
      await apiRequest(S.parallelA, 'req_par_a', 50, 500, 10_000, 0.1);
      await apiRequest(S.parallelB, 'req_par_b', 51, 510, 10_100, 0.101);
      // A's main checkout, then B's.
      await hookSpan(S.twoRepos, repoA);
      await apiRequest(S.twoRepos, 'req_two_a', 60, 600, 11_000, 0.11);
      await hookSpan(S.twoRepos, repoB);
      await apiRequest(S.twoRepos, 'req_two_b', 61, 610, 11_100, 0.111);
      await hookSpan(S.nested, nested);
      await apiRequest(S.nested, 'req_nested', 70, 700, 12_000, 0.12);
      // Slot 2 relaunched (new suffix, new occupancy) while the session goes on.
      await hookSpan(S.relaunch, slot2);
      await apiRequest(S.relaunch, 'req_relaunch_1', 80, 800, 13_000, 0.13);
      har(repoA, 'env', 'teardown', '2');
      har(repoA, 'env', 'launch', '2');
      har(repoA, 'control', 'sync', '--api-url', mcUrl);
      expect(slotDir(repoA, 2)).not.toBe(slot2);
      await hookSpan(S.relaunch, slotDir(repoA, 2));
      await apiRequest(S.relaunch, 'req_relaunch_2', 81, 810, 13_100, 0.131);
      // An OTLP retry of one request.
      await apiRequest(S.main, 'req_main_2', 12, 120, 6_000, 0.06);
      // A's main checkout → a slot of B → A again; its transcript is harvested too.
      const cross = [];
      for (const [cwd, requestId, input] of [
        [repoA, 'req_cross_a1', 90],
        [slotDir(repoB, 1), 'req_cross_b', 91],
        [repoA, 'req_cross_a2', 92],
      ] as const) {
        await hookSpan(S.crossRepo, cwd);
        cross.push({
          requestId,
          cwd,
          input,
          at: await apiRequest(S.crossRepo, requestId, input, 900, 14_000, 0.14),
        });
      }
      writeTranscript(S.crossRepo, repoA, cross);
      syncAll();
    }, 600_000);

    it('Mission Control holds no usage-invariant violation', async () => {
      const report = await api<UsageInvariantReport>('/api/usage/invariants');
      expect(report.violations).toEqual([]);
    });

    it('a resend and a --full resend keep every invariant', async () => {
      syncAll();
      syncAll('--full');
      const report = await api<UsageInvariantReport>('/api/usage/invariants');
      expect(report.violations).toEqual([]);
    }, 600_000);
  },
);
