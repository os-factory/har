import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PrismaClient } from '@prisma/client';

/**
 * A real SQLite database for a test file: `prisma db push` of a schema into a
 * temporary file. Tests that exercise queries (not only call shapes) use it
 * instead of a hand-written Prisma mock.
 */

const CONTROL_DIR = path.resolve(__dirname, '../../..');
export const V2_SCHEMA = path.join(CONTROL_DIR, 'prisma/schema.prisma');
export const V1_SCHEMA = path.join(CONTROL_DIR, 'src/server/fixtures/schema-v1.prisma');

export function tempDirectory(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Create the tables of `schema` in `file` (no client generation). */
export function pushSchema(file: string, schema: string = V2_SCHEMA): void {
  execFileSync(
    process.execPath,
    [require.resolve('prisma/build/index.js', { paths: [CONTROL_DIR] }), 'db', 'push', '--schema', schema, '--skip-generate'],
    { cwd: CONTROL_DIR, env: { ...process.env, DATABASE_URL: `file:${file}` }, stdio: 'pipe' },
  );
}

export function clientFor(file: string): PrismaClient {
  return new PrismaClient({ datasourceUrl: `file:${file}?connection_limit=1` });
}
