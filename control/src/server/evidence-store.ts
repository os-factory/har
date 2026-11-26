import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { ingestV2EvidencePath, Sha256HexSchema } from '@har/schemas';
import { prisma } from '@/lib/db';
import type { Db } from '@/server/ingest-v2';

/**
 * Evidence files (stage logs and artifacts, ADR 0005 section 4) stored by
 * digest on local disk, under Mission Control's data directory: next to its
 * SQLite database (`/data/evidence` in the container, `prisma/evidence` in a
 * harness slot), or `HAR_CONTROL_EVIDENCE_DIR`.
 */

/** Largest evidence file accepted. Stage logs are capped at 1 MiB; artifacts (screenshots, traces) are larger. */
export const MAX_EVIDENCE_BYTES = 100 * 1024 * 1024;

/** The SQLite file of a `file:` DATABASE_URL; relative paths resolve against `prisma/`, as Prisma does. */
function databaseDirectory(): string {
  const url = process.env.DATABASE_URL ?? '';
  const raw = url.startsWith('file:') ? url.slice('file:'.length).split('?')[0] : '';
  if (!raw) return path.resolve(process.cwd(), 'prisma');
  return path.dirname(path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), 'prisma', raw));
}

export function evidenceDirectory(): string {
  return process.env.HAR_CONTROL_EVIDENCE_DIR || path.join(databaseDirectory(), 'evidence');
}

/** Where a digest's bytes live, relative to the evidence directory (`ab/abcdef…`). */
export function evidenceLocation(sha256: string): string {
  return path.join(sha256.slice(0, 2), sha256);
}

function absolute(location: string): string {
  return path.join(evidenceDirectory(), location);
}

export function isSha256(value: string): boolean {
  return Sha256HexSchema.safeParse(value).success;
}

/** The digests of `digests` whose bytes Mission Control does not hold, each with its upload path. */
export async function missingEvidence(digests: string[], db: Db = prisma) {
  const unique = [...new Set(digests)];
  const stored = await db.evidenceBlob.findMany({
    where: { sha256: { in: unique }, location: { not: null } },
    select: { sha256: true, location: true },
  });
  const held = new Set(
    stored.filter((blob) => blob.location && fs.existsSync(absolute(blob.location))).map((blob) => blob.sha256),
  );
  return unique
    .filter((sha256) => !held.has(sha256))
    .map((sha256) => ({ sha256, uploadUrl: ingestV2EvidencePath(sha256) }));
}

export type StoreEvidenceResult =
  | { status: 'stored' | 'unchanged'; sha256: string; size: number }
  | { status: 'mismatch'; expected: string; actual: string }
  | { status: 'too-large'; size: number };

/** Hash the bytes; store them only when they match `sha256`. */
export async function storeEvidence(
  sha256: string,
  bytes: Uint8Array,
  mediaType: string | null,
  db: Db = prisma,
): Promise<StoreEvidenceResult> {
  if (bytes.byteLength > MAX_EVIDENCE_BYTES) return { status: 'too-large', size: bytes.byteLength };
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== sha256) return { status: 'mismatch', expected: sha256, actual };

  const location = evidenceLocation(sha256);
  const target = absolute(location);
  const existing = await db.evidenceBlob.findUnique({ where: { sha256 } });
  const onDisk = fs.existsSync(target);
  if (!onDisk) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, bytes);
    fs.renameSync(temporary, target);
  }
  const type = existing?.mediaType ?? (mediaType?.trim() || 'application/octet-stream');
  if (existing?.location === location && onDisk) return { status: 'unchanged', sha256, size: bytes.byteLength };
  await db.evidenceBlob.upsert({
    where: { sha256 },
    create: { sha256, size: bytes.byteLength, mediaType: type, location, storedAt: new Date() },
    update: { size: bytes.byteLength, location, storedAt: new Date() },
  });
  return { status: 'stored', sha256, size: bytes.byteLength };
}

/** The stored bytes of a digest, with their media type, or null. */
export async function readEvidence(sha256: string, db: Db = prisma) {
  const blob = await db.evidenceBlob.findUnique({ where: { sha256 } });
  if (!blob?.location) return null;
  const file = absolute(blob.location);
  if (!fs.existsSync(file)) return null;
  return { bytes: fs.readFileSync(file), mediaType: blob.mediaType, size: blob.size };
}
