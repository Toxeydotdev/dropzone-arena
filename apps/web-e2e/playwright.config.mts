import { workspaceRoot } from '@nx/devkit';
import { nxE2EPreset } from '@nx/playwright/preset';
import { defineConfig, devices } from '@playwright/test';

const isCi = Boolean(process.env['CI']);
const baseURL = process.env['BASE_URL'] ?? 'http://localhost:4301';
const authorityURL = 'http://localhost:4302';

const authorityEnvironment = {
  ADMISSION_ENABLED: 'true',
  ALLOWED_WEB_ORIGINS: baseURL,
  BUILD_ID: 'local-e2e',
  CONNECTION_ATTEMPTS_PER_MINUTE: '60',
  DRAIN_TIMEOUT_MS: '2000',
  MAX_CONNECTIONS: '48',
  MAX_PLAYERS_PER_ROOM: '8',
  MAX_RESERVATIONS: '16',
  MAX_ROOMS: '4',
  MAX_SESSIONS: '32',
  MAX_SESSIONS_PER_SOURCE: '4',
  PORT: '4302',
  QUICKPLAY_REQUESTS_PER_MINUTE: '12',
  ROOM_IDLE_TTL_MS: '30000',
  TRUSTED_PROXY_HOPS: '0',
};

export default defineConfig({
  ...nxE2EPreset(import.meta.dirname, { testDir: './src' }),
  forbidOnly: isCi,
  fullyParallel: false,
  retries: 0,
  workers: 1,
  use: {
    baseURL,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'node dist/apps/server/main.js',
      cwd: workspaceRoot,
      env: authorityEnvironment,
      reuseExistingServer: false,
      timeout: 120_000,
      url: `${authorityURL}/api/health`,
    },
    {
      command:
        'node node_modules/vite/bin/vite.js preview --config apps/web/vite.config.ts',
      cwd: workspaceRoot,
      reuseExistingServer: false,
      timeout: 120_000,
      url: baseURL,
    },
  ],
  projects: [
    {
      grepInvert: /@mobile/,
      name: 'desktop-chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 720 },
      },
    },
    {
      grepInvert: /@desktop/,
      name: 'mobile-chromium',
      use: { ...devices['Pixel 7'] },
    },
  ],
});
