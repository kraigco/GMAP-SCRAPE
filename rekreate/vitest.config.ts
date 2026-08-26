import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // No global test timeout override: network-touching stages are tested
    // against fixtures, not the live APIs.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/cli/**', 'src/db/migrations/**'],
    },
  },
});
