import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: 'html',
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000',
    trace: 'on-first-retry',
  },
  webServer: [
    {
      command: 'npm run dev --workspace=@pixel-barber/customer -- --port 3000',
      url: 'http://localhost:3000',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: 'npm run dev --workspace=@pixel-barber/staff -- --port 3001',
      url: 'http://localhost:3001',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
