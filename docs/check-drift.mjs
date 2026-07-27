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

const templateRoot = path.join(root, 'src/templates/stage-templates');
const templateIds = fs
  .readdirSync(templateRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(templateRoot, entry.name, 'template.manifest.json'))
  .filter((manifestPath) => fs.existsSync(manifestPath))
  .map((manifestPath) => JSON.parse(fs.readFileSync(manifestPath, 'utf8')).id);
requireTerms(
  docs.stages,
  templateIds.map((value) => `add-stage ${value}`),
  'Stages guide',
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

if (failures.length > 0) {
  console.error('Documentation drift detected:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(
  `Documentation contract is current: ${envCommands.length} CLI signatures, ${mcpTools.length} MCP tools, ${stageKinds.length} stage kinds, ${templateIds.length} templates, ${skillIds.length} skills.`,
);
