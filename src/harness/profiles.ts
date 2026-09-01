import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { resolveTemplatesDir } from '../utils/paths';

/** Shipped profile ids — CLI choices. Any manifest-backed id works at runtime (#236). */
export type HarnessProfile = 'default' | 'cli' | 'ios';

export const HARNESS_PROFILES = ['default', 'cli', 'ios'] as const;

const ProfileBundleRefSchema = z.object({
  /** Stable bundle id recorded in .har/plugins.json */
  id: z.string().min(1),
  /**
   * Directory under src/templates/ (e.g. "runtime-bundles/shared-kernel"
   * or "har-boilerplate").
   */
  path: z.string().min(1),
});

/**
 * Capability set consumed by the package runtime (#236): behavior is declared
 * here as data, never inferred from which template files happen to exist.
 */
export const ProfileCapabilitiesSchema = z.object({
  /** Per-slot process orchestration: PM2 apps, iOS simulator, or none. */
  processManager: z.enum(['pm2', 'none', 'simulator']),
  /** Whether launch allocates per-slot FE/API/DEBUG port lanes by default. */
  appPortLanes: z.boolean(),
  infra: z.object({
    /** HARNESS_INFRA_SERVICES default for a fresh scaffold. */
    defaultServices: z.array(z.string().min(1)),
    /** HARNESS_INFRA_PORT_LANES default string ("" when the profile has no lanes). */
    portLanes: z.string(),
  }),
  /** Stage ids the profile's stages.json ships with (consistency-checked in tests). */
  defaultStages: z.array(z.string().min(1)).min(1),
  /** Exported keys the profile's harness.env ships with (consistency-checked in tests). */
  defaultEnvKeys: z.array(z.string().min(1)).min(1),
});

export type ProfileCapabilities = z.infer<typeof ProfileCapabilitiesSchema>;

export const ProfileManifestSchema = z.object({
  /** Profile id — shipped ids plus any future manifest-backed profile. */
  id: z.string().min(1),
  description: z.string().min(1),
  /** Ordered runtime bundles — later bundles overwrite earlier files on conflict. */
  bundles: z.array(ProfileBundleRefSchema).min(1),
  capabilities: ProfileCapabilitiesSchema,
  /**
   * Assembled docs: generated file name → ordered section names. Sections
   * resolve to profiles/<id>/docs/<docdir>/<name>.md when the profile overrides
   * them, else shared-docs/<docdir>/<name>.md.
   */
  docs: z.record(z.string().min(1), z.array(z.string().min(1)).min(1)),
});

export type ProfileManifest = z.infer<typeof ProfileManifestSchema>;
export type ProfileBundleRef = z.infer<typeof ProfileBundleRefSchema>;

export interface ProfileReadOptions {
  /** Override the packaged templates dir (tests / synthetic profiles). */
  templatesDir?: string;
}

function templatesDirFor(options?: ProfileReadOptions): string {
  return options?.templatesDir ?? resolveTemplatesDir();
}

export function readProfileManifest(profile: string, options?: ProfileReadOptions): ProfileManifest {
  const templates = templatesDirFor(options);
  const manifestPath = path.join(templates, 'profiles', profile, 'profile.manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Profile manifest not found: ${manifestPath}. Run npm run build.`);
  }
  const parsed = ProfileManifestSchema.safeParse(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
  if (!parsed.success) {
    throw new Error(`Invalid profile manifest for ${profile}: ${parsed.error.message}`);
  }
  if (parsed.data.id !== profile) {
    throw new Error(`Profile manifest id mismatch: expected ${profile}, got ${parsed.data.id}`);
  }
  return parsed.data;
}

/** Capability set for a profile id, or undefined when the manifest is unreadable. */
export function readProfileCapabilities(
  profile: string,
  options?: ProfileReadOptions,
): ProfileCapabilities | undefined {
  try {
    return readProfileManifest(profile, options).capabilities;
  } catch {
    return undefined;
  }
}

export function resolveProfileBundleDir(bundle: ProfileBundleRef, options?: ProfileReadOptions): string {
  const dir = path.join(templatesDirFor(options), bundle.path);
  if (!fs.existsSync(dir)) {
    throw new Error(`Profile bundle not found: ${bundle.id} (${bundle.path}). Run npm run build.`);
  }
  return dir;
}

export function listProfileBundleIds(profile: string): string[] {
  return readProfileManifest(profile).bundles.map((b) => b.id);
}

/** "README.md" → "readme" */
function docSectionDir(docName: string): string {
  return docName
    .replace(/\.md$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Assemble a generated doc (README.md) for a profile from
 * ordered sections — profile override first, shared-docs fallback (#236).
 */
export function renderProfileDoc(
  profile: string,
  docName: string,
  options?: ProfileReadOptions,
): string {
  const manifest = readProfileManifest(profile, options);
  const sections = manifest.docs[docName];
  if (!sections) {
    throw new Error(`Profile ${profile} declares no docs entry for ${docName}`);
  }
  const templates = templatesDirFor(options);
  const dir = docSectionDir(docName);
  const parts = sections.map((name) => {
    const profilePath = path.join(templates, 'profiles', profile, 'docs', dir, `${name}.md`);
    const sharedPath = path.join(templates, 'shared-docs', dir, `${name}.md`);
    const sectionPath = fs.existsSync(profilePath) ? profilePath : sharedPath;
    if (!fs.existsSync(sectionPath)) {
      throw new Error(`Doc section not found for ${profile}/${docName}: ${name} (${sectionPath})`);
    }
    return fs.readFileSync(sectionPath, 'utf8');
  });
  return parts.join('\n');
}

export interface ComposedTemplateEntry {
  /** Path relative to the composed .har/ root (e.g. "harness.env", "stages/README.sh"). */
  relPath: string;
  /** Absolute path of the winning source file ("" for rendered docs). */
  sourcePath: string;
  /** Bundle that serves the file after composition (later bundles win). */
  bundleId: string;
  /** Rendered content for assembled files (docs) that have no single source file. */
  content?: string;
}

/** Template content for a composed entry — rendered content or the source file. */
export function readComposedTemplateContent(entry: ComposedTemplateEntry): string {
  if (entry.content !== undefined) return entry.content;
  return fs.readFileSync(entry.sourcePath, 'utf8');
}

function walkTemplateFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...walkTemplateFiles(path.join(dir, entry.name), rel));
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out.sort();
}

/**
 * Composed template view for a profile: relPath → winning source, applying
 * bundle order (later bundles overwrite earlier ones — same rule as scaffold),
 * plus the assembled docs (README.md) as rendered entries.
 * Drift/maintain must resolve template content through this map, never through
 * a single overlay dir: bundle-provided files no longer exist in the overlays.
 */
export function composeProfileTemplateMap(
  profile: string,
  options?: ProfileReadOptions,
): Map<string, ComposedTemplateEntry> {
  const map = new Map<string, ComposedTemplateEntry>();
  const manifest = readProfileManifest(profile, options);
  for (const bundle of manifest.bundles) {
    const dir = resolveProfileBundleDir(bundle, options);
    for (const relPath of walkTemplateFiles(dir)) {
      map.set(relPath, { relPath, sourcePath: path.join(dir, relPath), bundleId: bundle.id });
    }
  }
  for (const docName of Object.keys(manifest.docs)) {
    map.set(docName, {
      relPath: docName,
      sourcePath: '',
      bundleId: 'profile-docs',
      content: renderProfileDoc(profile, docName, options),
    });
  }
  return map;
}
