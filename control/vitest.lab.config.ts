import { defineConfig } from 'vitest/config';
import path from 'path';

/**
 * Lab config — integration checks that need a REAL database and the real HAR
 * CLI, not the mocked-prisma unit tests. Kept out of `npm test` on purpose:
 * these run only inside the occupancy lab container (#316 station S3), via
 * `har line gate S3 --line occupancy-identity`.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.lab.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@har/schemas': path.resolve(__dirname, '../packages/schemas/src/index.ts'),
    },
  },
});
