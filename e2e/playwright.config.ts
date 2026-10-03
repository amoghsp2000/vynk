import { defineConfig } from '@playwright/test';

/**
 * Browser end-to-end tests against a running stack:
 *   docker compose up -d postgres redis minio minio-init coturn
 *   (cd server && npm run dev) ; (cd client && npm run dev)
 *   (cd e2e && npm test)
 * Override the target with E2E_BASE_URL (e.g. http://localhost:8080 for the docker client).
 */
export default defineConfig({
  testDir: './tests',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    permissions: ['microphone', 'notifications'],
    launchOptions: {
      // Fake mic (a test tone) + auto-accept the permission prompt.
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
    },
    trace: 'retain-on-failure',
  },
});
