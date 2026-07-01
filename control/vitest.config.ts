import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@har/schemas': path.resolve(__dirname, '../packages/schemas/src/index.ts'),
    },
  },
});
