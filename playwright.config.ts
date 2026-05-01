import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  use: {
    headless: true,
    viewport: { width: 1280, height: 800 },
  },
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        launchOptions: {
          executablePath: '/usr/bin/chromium',
        },
      },
    },
  ],
  webServer: [
    {
      command: 'npm run dev --workspace dome-control-server',
      url: 'http://127.0.0.1:8081/peerjs',
      reuseExistingServer: true,
      timeout: 30_000,
    },
    {
      command: 'npm run dev --workspace war-and-peace -- --host 127.0.0.1 --port 5173',
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: true,
      timeout: 30_000,
    },
    {
      command: 'npm run dev --workspace dome-control-client -- --host 127.0.0.1 --port 5176',
      url: 'http://127.0.0.1:5176',
      reuseExistingServer: true,
      timeout: 30_000,
    },
  ],
})
