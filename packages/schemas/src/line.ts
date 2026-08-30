import { z } from 'zod';
import { HarnessStageKindSchema, HarnessStageSchema } from './schema';

/**
 * Factory line schemas (#302 Phase 2 / #304).
 *
 * A *line* is a program: an ordered set of stations plus a cumulative gate.
 * It is installed like a plugin (path → git → bundled → npm) but its apply
 * path may NEVER touch `verificationStages` — line gate stages are opt-in and
 * are run by `har line gate`, never by `har env verify --full`.
 */

/** Program contract version — see .claude/skills/factory-line/LINE.schema.md. */
export const LINE_CONTRACT_VERSION = 1;

/** Discriminator that separates a line bundle from a verification plugin. */
export const LINE_BUNDLE_KIND = 'line';

/** Manifest file names a line bundle may use, in resolution order. */
export const LINE_MANIFEST_FILES = ['line.manifest.json', 'template.manifest.json'] as const;

export const LineIdSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, 'Line id must be a lowercase slug (letters, digits, ._-)');

export const StationIdSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'Station id must be stable and shell-friendly');

export const LineSkillSchema = z.object({
  id: z.string().min(1),
  role: z.enum(['orchestrator', 'station']).default('station'),
  /** Install hint only — HAR never vendors third-party skill packs. */
  install: z.string().min(1).optional(),
});

export const LineMcpSchema = z.object({
  name: z.string().min(1),
  why: z.string().min(1).optional(),
  required: z.boolean().default(false),
});

export const LineWorkSchema = z.object({
  /** `github`, `linear`, `none`, or a free string. */
  source: z.string().min(1).default('none'),
  ids: z.array(z.string().min(1)).default([]),
  url: z.string().min(1).optional(),
  optional: z.boolean().default(false),
});

export const LineWaveCellSchema = z.object({
  workId: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
});

export const LineStationSchema = z.object({
  id: StationIdSchema,
  title: z.string().min(1),
  description: z.string().min(1).optional(),
  work: LineWorkSchema.optional(),
  /** Each inner array is one wave; cells inside a wave run in parallel slots. */
  waves: z.array(z.array(LineWaveCellSchema)).optional(),
  skills: z.array(z.string().min(1)).optional(),
  mcp: z.array(z.string().min(1)).optional(),
});

export const LineGateStageSchema = z.object({
  id: z.string().min(1),
  /** Required from this station onward — this is the ratchet tag. */
  fromStation: StationIdSchema,
  tier: z.enum(['quick', 'full']).default('full'),
});

export const LineGateSchema = z.object({
  /** Must be true: a factory line never drops an earlier station's stages. */
  cumulative: z.literal(true),
  /** When set, the gate is skipped unless this env var is "1". */
  optInEnv: z.string().min(1).nullable().default(null),
  stages: z.array(LineGateStageSchema).default([]),
});

export const LineExtraStageSchema = z.object({
  id: z.string().min(1),
  kind: HarnessStageKindSchema.default('test'),
  tier: z.enum(['quick', 'full']).default('full'),
  description: z.string().min(1).optional(),
});

export const LineHandoffSchema = z.object({
  /** Must be false: agents hand off, they do not merge or release. */
  autonomousShip: z.literal(false),
  waitFor: z.string().min(1).optional(),
});

export const LineTravelerSchema = z.object({
  kind: z.string().min(1),
  ref: z.string().min(1).optional(),
  note: z.string().min(1).optional(),
});

/** The program itself — `.har/lines/<id>/line.json`. */
export const LineProgramSchema = z
  .object({
    contractVersion: z.literal(LINE_CONTRACT_VERSION),
    id: LineIdSchema,
    title: z.string().min(1),
    description: z.string().min(1).optional(),
    skills: z.array(LineSkillSchema).default([]),
    mcp: z.array(LineMcpSchema).default([]),
    plugins: z.array(z.string().min(1)).default([]),
    stations: z.array(LineStationSchema).min(1),
    gate: LineGateSchema,
    extraStages: z.array(LineExtraStageSchema).default([]),
    handoff: LineHandoffSchema,
    traveler: LineTravelerSchema.optional(),
    prototypeNotes: z.array(z.string().min(1)).default([]),
  })
  .superRefine((data, ctx) => {
    const stationIds = new Set(data.stations.map((s) => s.id));
    if (stationIds.size !== data.stations.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'station ids must be unique' });
    }
    for (const stage of data.gate.stages) {
      if (!stationIds.has(stage.fromStation)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `gate.stages[].fromStation "${stage.fromStation}" is not a station id`,
        });
      }
    }
  });

export type LineProgram = z.infer<typeof LineProgramSchema>;
export type LineStation = z.infer<typeof LineStationSchema>;
export type LineGateStage = z.infer<typeof LineGateStageSchema>;

const LineManifestFileSchema = z.object({
  src: z.string().min(1),
  dest: z.string().min(1),
  executable: z.boolean().optional(),
});

/**
 * Manifest for an installable line bundle — `line.manifest.json`.
 *
 * `verificationStages` is rejected outright rather than allowed-if-empty: the
 * whole point of a separate bundle kind is that apply cannot widen verify.
 */
export const LineManifestSchema = z
  .object({
    kind: z.literal(LINE_BUNDLE_KIND),
    id: LineIdSchema,
    title: z.string().min(1).optional(),
    /** Bundle-relative path to the program JSON. */
    program: z.string().min(1).default('line.json'),
    files: z.array(LineManifestFileSchema).default([]),
    /** Stages to REGISTER in .har/stages.json — never added to verificationStages. */
    stages: z.array(HarnessStageSchema).default([]),
    nextSteps: z.array(z.string().min(1)).default([]),
    docsPath: z.string().min(1).optional(),
  })
  .passthrough()
  .superRefine((data, ctx) => {
    const raw = data as Record<string, unknown>;
    if (raw.verificationStages !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Line manifests must not declare verificationStages — line gate stages are opt-in and run via `har line gate`.',
      });
    }
  });

export type LineManifest = z.infer<typeof LineManifestSchema>;

export const LineLedgerEntrySchema = z.object({
  id: LineIdSchema,
  source: z.enum(['bundled', 'local', 'path', 'npm', 'git']),
  spec: z.string().min(1),
  version: z.string().optional(),
  /** Stages this line registered (registered only — not on verify). */
  stageIds: z.array(z.string().min(1)).default([]),
  programPath: z.string().min(1),
  installedAt: z.string(),
});

export type LineLedgerEntry = z.infer<typeof LineLedgerEntrySchema>;

export const LineLedgerSchema = z.object({
  version: z.literal('1'),
  lines: z.array(LineLedgerEntrySchema).default([]),
});

export type LineLedger = z.infer<typeof LineLedgerSchema>;
