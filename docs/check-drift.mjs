import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const docsRoot = 'docs/src/content/docs/docs';
const docs = {
  cli: read(`${docsRoot}/reference/cli.md`),
  mcp: read(`${docsRoot}/reference/mcp.md`),
  stages: read(`${docsRoot}/guides/stages.md`),
  plugins: read(`${docsRoot}/guides/plugins.md`),
  profiles: read(`${docsRoot}/guides/profiles.md`),
  integrations: read(`${docsRoot}/guides/agent-integrations.md`),
  harnessFiles: read(`${docsRoot}/reference/harness-files.md`),
};
const failures = [];

function literals(source) {
  return [...source.matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

function block(source, pattern, label) {
  const match = source.match(pattern);
  if (!match) {
    failures.push(`Could not read canonical ${label}`);
    return '';
  }
  return match[1];
}

function requireTerms(document, terms, label) {
  for (const term of terms) {
    if (!document.includes(term)) failures.push(`${label} is missing ${term}`);
  }
}

const schema = read('packages/schemas/src/schema.ts');
const stageKinds = literals(
  block(schema, /HAR_STAGE_KINDS\s*=\s*\[([\s\S]*?)\]\s*as const/, 'stage kinds'),
);
const artifactKinds = literals(
  block(
    schema,
    /HarnessArtifactKindSchema\s*=\s*z\.enum\(\[([\s\S]*?)\]\)/,
    'artifact kinds',
  ),
);
const profiles = literals(
  block(schema, /profile:\s*z\.enum\(\[([\s\S]*?)\]\)/, 'harness profiles'),
);
const agentTargets = literals(
  block(
    schema,
    /AgentSkillTargetSchema\s*=\s*z\.enum\(\[([\s\S]*?)\]\)/,
    'agent targets',
  ),
);
const stageFields = [
  ...block(
    schema,
    /HarnessStageSchema\s*=\s*z[\s\S]*?\.object\(\{([\s\S]*?)\}\)\s*\.passthrough/,
    'stage fields',
  ).matchAll(/^\s{4}([A-Za-z][A-Za-z0-9]*):/gm),
].map((match) => match[1]);

requireTerms(docs.stages, stageKinds.map((value) => `\`${value}\``), 'Stages guide');
requireTerms(docs.stages, artifactKinds.map((value) => `\`${value}\``), 'Stages guide');
requireTerms(docs.stages, stageFields.map((value) => `\`${value}\``), 'Stages guide');
requireTerms(docs.profiles, profiles.map((value) => `\`${value}\``), 'Profiles guide');
requireTerms(docs.integrations, agentTargets, 'Agent integrations guide');

const pluginRoot = path.join(root, 'src/templates/plugins');
const pluginIds = fs
  .readdirSync(pluginRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(pluginRoot, entry.name, 'template.manifest.json'))
  .filter((manifestPath) => fs.existsSync(manifestPath))
  .map((manifestPath) => JSON.parse(fs.readFileSync(manifestPath, 'utf8')).id);
requireTerms(
  docs.stages,
  pluginIds.map((value) => `add-plugin ${value}`),
  'Stages guide',
);
requireTerms(
  docs.plugins,
  pluginIds.map((value) => `add-plugin ${value}`),
  'Plugins guide',
);

const mcpTools = [
  ...read('src/mcp/server.ts').matchAll(/name:\s*'(har_[a-z_]+)'/g),
].map((match) => match[1]);
requireTerms(docs.mcp, mcpTools.map((value) => `\`${value}\``), 'MCP reference');

const skillIds = JSON.parse(read('src/templates/agent-skills/skills.manifest.json')).skills.map(
  (skill) => skill.id,
);
requireTerms(
  docs.integrations,
  skillIds.map((value) => `/${value}`),
  'Agent integrations guide',
);

const envCommands = [
  ...read('src/cli/commands/env.ts').matchAll(/\.command\(\s*'([^']+)'/g),
].map((match) => match[1].split(/\s/)[0]);
requireTerms(docs.cli, [...new Set(envCommands)], 'CLI reference');

requireTerms(docs.harnessFiles, ['`.har/STAGES.md`'], 'Harness files reference');

const astroConfig = read('docs/astro.config.mjs');
const slugs = [...astroConfig.matchAll(/slug:\s*'([^']+)'/g)].map((match) => match[1]);
for (const slug of slugs) {
  const base = path.join(root, 'docs/src/content/docs', slug);
  if (!fs.existsSync(`${base}.md`) && !fs.existsSync(`${base}.mdx`)) {
    failures.push(`Sidebar slug has no page: ${slug}`);
  }
}

const packageJson = JSON.parse(read('package.json'));
if (!read('README.md').includes(packageJson.homepage)) {
  failures.push(`README is missing package homepage ${packageJson.homepage}`);
}
if (!astroConfig.includes("site: 'https://harproject.dev'") || !astroConfig.includes("base: '/'")) {
  failures.push('Astro site/base no longer match the documentation custom domain');
}

// Prose guards — prevent reintroducing removed launch UX or nonexistent commands.
const quickStart = read(`${docsRoot}/getting-started/quick-start.md`);
const agentWorkflow = read(`${docsRoot}/guides/agent-workflow.md`);
const bannedPhrases = [
  { phrase: 'har env restart', label: 'nonexistent CLI command' },
  { phrase: 'confirmReplace', label: 'removed MCP launch flag (#121)' },
  { phrase: 'launch --replace', label: 'removed launch flag (#121)' },
  { phrase: '--replace', label: 'removed launch/preflight flag (#121)' },
];
const proseDocs = [
  ['CLI reference', docs.cli],
  ['MCP reference', docs.mcp],
  ['Quick start', quickStart],
  ['Agent workflow', agentWorkflow],
];
for (const { phrase, label } of bannedPhrases) {
  for (const [name, document] of proseDocs) {
    if (document.includes(phrase)) {
      // Allow "replace" wording about init --force / harness recreation only when
      // the banned token is specifically about launch --replace / confirmReplace.
      failures.push(`${name} still mentions ${phrase} (${label})`);
    }
  }
}
if (/\brequires `--force`/.test(quickStart) || /requires --force/.test(quickStart)) {
  failures.push(
    'Quick start still describes occupied-slot launch with requires --force (removed in #121)',
  );
}
requireTerms(docs.cli, ['--portal'], 'CLI reference (control login)');
requireTerms(docs.mcp, ['ios'], 'MCP reference (har_init_harness profile)');
requireTerms(docs.mcp, ['worktree'], 'MCP reference (har_launch_environment)');

const cursorRuleTemplate = read('src/templates/cursor-rule.mdc.template');
const cursorRuleLines = cursorRuleTemplate.split('\n').length;
if (cursorRuleLines > 80) {
  failures.push(
    `cursor-rule.mdc.template is ${cursorRuleLines} lines (max 80) — keep the always-on rule slim`,
  );
}
if (cursorRuleTemplate.includes('har env restart')) {
  failures.push('cursor-rule.mdc.template mentions nonexistent har env restart');
}

if (failures.length > 0) {
  console.error('Documentation drift detected:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(
  `Documentation contract is current: ${envCommands.length} CLI signatures, ${mcpTools.length} MCP tools, ${stageKinds.length} stage kinds, ${pluginIds.length} plugins, ${skillIds.length} skills.`,
);
