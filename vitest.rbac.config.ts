import { defineConfig } from 'vitest/config';

// The role/permission suite (hits staging, slow): `npm run test:rbac`. The default config
// (vitest.config.ts) excludes tests/db/rbac.
export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    include: ['tests/db/rbac/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/.next/**', 'e2e/**'],
  },
});
