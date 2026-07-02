import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    // Unit tests live in src/ — tests/ holds Playwright specs (run via test:e2e)
    include: ['src/**/*.test.{ts,tsx}'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@har/schemas': path.resolve(__dirname, '../packages/schemas/src/index.ts'),
    },
  },
});
