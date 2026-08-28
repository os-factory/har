import { execFileSync } from 'child_process';
import * as path from 'path';

/**
 * #311 acceptance: the release contract documented in AGENTS.md and
 * CONTRIBUTING.md must be what semantic-release actually does.
 *
 * The default angular preset silently ignored the Conventional Commits `!`
 * marker: `feat!: x` analyzed to `null`, so seven breaking changes on the v1
 * branch bumped nothing and never reached the changelog. Nothing failed — a
 * release still happened, with the wrong number and incomplete notes. That is
 * exactly the kind of regression a test has to hold down.
 *
 * The analyzer is ESM and pulls in the preset at runtime, so this drives it in
 * a child process rather than fighting ts-jest/ESM interop.
 */
const REPO_ROOT = path.resolve(__dirname, '..');

function releaseTypeFor(messages: string[]): (string | null)[] {
  const script = `
    const { createRequire } = await import('module');
    const require = createRequire(${JSON.stringify(REPO_ROOT + '/')});
    const analyzer = await import(${JSON.stringify(REPO_ROOT + '/node_modules/@semantic-release/commit-analyzer/index.js')});
    const cfg = require(${JSON.stringify(REPO_ROOT + '/release.config.cjs')});
    const aCfg = cfg.plugins.find((p) => Array.isArray(p) && p[0] === '@semantic-release/commit-analyzer')[1];
    const out = [];
    for (const m of ${JSON.stringify(messages)}) {
      out.push(await analyzer.analyzeCommits(aCfg, {
        commits: [{ hash: 'x', subject: m.split('\\n')[0], body: m.split('\\n').slice(2).join('\\n'), message: m }],
        logger: { log() {} },
        cwd: ${JSON.stringify(REPO_ROOT)},
        options: {},
      }));
    }
    process.stdout.write(JSON.stringify(out));
  `;
  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 32,
  });
  return JSON.parse(stdout);
}

describe('release contract (#311)', () => {
  // The whole point of the fix: `!` means breaking, with or without a footer.
  it.each([
    ['feat!: x', 'major'],
    ['fix!: x', 'major'],
    ['feat(scope)!: x', 'major'],
    ['feat: x\n\nBREAKING CHANGE: y', 'major'],
    ['feat: x', 'minor'],
    ['fix: x', 'patch'],
  ])('%s => %s', (message, expected) => {
    expect(releaseTypeFor([message])[0]).toBe(expected);
  });

  // The no-release rules AGENTS.md promises must survive the preset change.
  it.each([
    'docs: x',
    'ci: x',
    'chore: x',
    'refactor: x',
    'test: x',
    'feat(ci): x',
    'feat(docs): x',
    'feat(benchmark): x',
    'fix(ci): x',
  ])('%s does not release', (message) => {
    expect(releaseTypeFor([message])[0]).toBeNull();
  });

  it('the analyzer and the notes generator agree on the preset', () => {
    // Versioning correctly while rendering notes with a different preset is the
    // half-fixed state that drops breaking changes from the changelog.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const cfg = require(path.join(REPO_ROOT, 'release.config.cjs'));
    const pluginOpts = (name: string) => {
      const entry = cfg.plugins.find((p: unknown) => Array.isArray(p) && p[0] === name);
      return entry ? entry[1] : undefined;
    };
    const analyzer = pluginOpts('@semantic-release/commit-analyzer');
    const notes = pluginOpts('@semantic-release/release-notes-generator');
    expect(analyzer?.preset).toBe('conventionalcommits');
    expect(notes?.preset).toBe('conventionalcommits');
  });
});
