import * as fs from 'fs';
import * as path from 'path';

/**
 * Enterprise-free guard (FE-1446).
 *
 * The open-core repo — the CLI (`src/`) and the Mission Control app
 * (`control/src`) — must not carry Team-edition (enterprise) code. The portal
 * push added in FE-1446 is deliberately generic: a bearer token over HTTP, with
 * no identity-provider, billing, or EE-specific dependency leaking into core.
 *
 * This test fails the build (locally via `verify --full` and in CI) if any
 * source file references an enterprise marker. har-portal owns all of these;
 * core must stay free of them. If a match is a genuine false positive, narrow
 * the pattern here with a comment — do not weaken the guard wholesale.
 */

// Case-insensitive markers of enterprise/identity/billing code that belongs to
// har-portal, never the open core.
const BANNED = [
  /zitadel/i, // Zitadel OIDC — har-portal EE (FE-1449)
  /next-auth/i, // Auth.js — har-portal EE
  /@auth\/core/i, // Auth.js core — har-portal EE
  /\bstripe\b/i, // billing — har-portal EE (FE-1454)
];

const SKIP_DIRS = new Set([
  'node_modules',
  '.next',
  'dist',
  'coverage',
  '.git',
  'artifacts',
  '.har',
]);

function sourceFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

describe('open core stays enterprise-free', () => {
  const repoRoot = path.resolve(__dirname, '..');
  const roots = [
    path.join(repoRoot, 'src'),
    path.join(repoRoot, 'control', 'src'),
  ];
  const files = roots.flatMap(sourceFiles);

  it('scans a non-trivial set of source files', () => {
    // Guard against the walker silently finding nothing (e.g. a path change).
    expect(files.length).toBeGreaterThan(10);
  });

  it('contains no enterprise markers', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      for (const pattern of BANNED) {
        if (pattern.test(content)) {
          offenders.push(`${path.relative(repoRoot, file)} — matched ${pattern}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
