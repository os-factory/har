import * as fs from 'fs';
import * as path from 'path';
import { resolveTemplatesDir } from '../utils/paths';
import { harnessExists } from './parser';
import { HarnessStageKind, HarnessStageKindSchema } from './schema';
import { LOCAL_PLUGINS_DIR } from './plugin-resolve';
import { PluginManifest, PluginManifestSchema } from './plugins';

export interface CreateLocalPluginOptions {
  id: string;
  kind?: HarnessStageKind;
  description?: string;
  /** Scaffold a package.fragment.json merged into package.json on install. */
  packageFragment?: boolean;
  force?: boolean;
}

export interface CreateLocalPluginResult {
  pluginId: string;
  pluginDir: string;
  filesWritten: string[];
  nextSteps: string[];
}

const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

function renderSkeleton(templatePath: string, tokens: Record<string, string>): string {
  let content = fs.readFileSync(templatePath, 'utf8');
  for (const [token, value] of Object.entries(tokens)) {
    content = content.replace(new RegExp(token, 'g'), value);
  }
  return content;
}

/**
 * Scaffold a complete project-owned plugin at `.har/plugins/<id>/`:
 * manifest (validated by PluginManifestSchema before writing), a stage
 * script from the contract skeleton, a README, and optionally a
 * package.json fragment. Installing it (`har env add-plugin <id>`) registers
 * its stages exactly like bundled/npm/git plugins.
 */
export function createLocalPlugin(
  repoPath: string,
  options: CreateLocalPluginOptions,
): CreateLocalPluginResult {
  const resolved = path.resolve(repoPath);
  if (!harnessExists(resolved)) {
    throw new Error('No .har/ harness found. Run "har env init" first.');
  }

  const id = options.id.trim();
  if (!PLUGIN_ID_PATTERN.test(id)) {
    throw new Error(
      `Invalid plugin id "${id}". Use lowercase letters, digits, dots, dashes (e.g. "db-integrity").`,
    );
  }

  const kind = options.kind ?? 'test';
  if (!HarnessStageKindSchema.options.includes(kind)) {
    throw new Error(
      `Invalid stage kind "${kind}". Available: ${HarnessStageKindSchema.options.join(', ')}`,
    );
  }

  const pluginDir = path.join(resolved, LOCAL_PLUGINS_DIR, id);
  const pluginDirRel = `${LOCAL_PLUGINS_DIR}/${id}`;
  if (fs.existsSync(pluginDir) && !options.force) {
    throw new Error(`Plugin already exists: ${pluginDirRel}/. Use --force to overwrite.`);
  }

  const description = options.description ?? `Custom ${kind} stage (local plugin: ${id})`;

  const manifest: PluginManifest = PluginManifestSchema.parse({
    id,
    verificationStages: [id],
    stages: [
      {
        id,
        kind,
        description,
        script: `stages/${id}.sh`,
        requiresAgentId: true,
        artifacts: [
          {
            path: `.har/artifacts/${id}`,
            kind: 'directory',
            description: `Artifacts for the ${id} stage`,
          },
        ],
        tier: 'full',
      },
    ],
    files: [
      {
        src: `stages/${id}.sh`,
        dest: `.har/stages/${id}.sh`,
        executable: true,
      },
    ],
    ...(options.packageFragment ? { merge: { 'package.json': 'package.fragment.json' } } : {}),
    nextSteps: [
      `Edit ${pluginDirRel}/stages/${id}.sh — replace the TODO block with the real check`,
      './.har/launch.sh 1',
      `./.har/stages/${id}.sh 1`,
      './.har/verify.sh 1 --full   # runs it as part of full verification',
    ],
    docsPath: `${pluginDirRel}/README.md`,
  });

  const filesWritten: string[] = [];
  const write = (rel: string, content: string, executable = false): void => {
    const abs = path.join(pluginDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    if (executable) fs.chmodSync(abs, 0o755);
    filesWritten.push(`${pluginDirRel}/${rel}`);
  };

  write('template.manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);

  const stageScript = renderSkeleton(
    path.join(resolveTemplatesDir(), 'plugins', 'custom-stage-skeleton.sh'),
    {
      __STAGE_ID__: id,
      __STAGE_KIND__: kind,
      __STAGE_DESCRIPTION__: description,
    },
  );
  write(`stages/${id}.sh`, stageScript, true);

  const readme = renderSkeleton(
    path.join(resolveTemplatesDir(), 'plugins', 'local-plugin-skeleton', 'README.md'),
    { __PLUGIN_ID__: id },
  );
  write('README.md', readme);

  if (options.packageFragment) {
    write(
      'package.fragment.json',
      `${JSON.stringify({ scripts: {}, devDependencies: {} }, null, 2)}\n`,
    );
  }

  return {
    pluginId: id,
    pluginDir,
    filesWritten,
    nextSteps: [
      `Edit ${pluginDirRel}/stages/${id}.sh — replace the TODO block with the real check`,
      `Install it: har env add-plugin ${id}   (re-run with --force after changes)`,
      `Document what it checks in ${pluginDirRel}/README.md`,
      'Publishing later (npm/git) needs zero format changes — see the README',
    ],
  };
}
