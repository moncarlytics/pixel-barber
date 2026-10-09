import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    include: [
      'apps/**/*.{test,spec}.{ts,tsx}',
      'packages/**/*.{test,spec}.{ts,tsx}',
      'tests/**/*.{test,spec}.{ts,tsx}',
    ],
    // tests/db/rbac hits staging and is slow: run it with `npm run test:rbac`.
    exclude: ['**/node_modules/**', '**/.next/**', 'e2e/**', 'tests/db/rbac/**'],
    // No test files exist yet in Phase 0 — the CI suite must still pass empty.
    passWithNoTests: true,
  },
});
