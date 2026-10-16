import { defineConfig, devices } from "@playwright/test";

/**
 * INT-102: browser/dashboard vertical slice against the fixture-backed Application API.
 *
 * The API and dashboard processes are started by worker-scoped fixtures
 * (`tests/e2e/support/fixtures.ts`) rather than `webServer`, because each run reserves
 * collision-safe ephemeral ports and injects a fresh development token. Run with
 * `npm run test:e2e` (browser binaries: `npm run test:e2e:install`).
 */
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: /.*\.e2e\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
