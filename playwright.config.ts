// Task 5.2 (TASKS.md), per docs/design/testing.md's End-to-end tests
// section: drive the actual UI in a browser, covering the workflows in
// docs/user-stories.md. Reuses vitest.config.ts's loadEnv pattern (same
// reasoning: Playwright doesn't auto-load .env.local the way Next.js
// does, and `vite` is already a transitive dependency via vitest - no
// new package needed for this).
import { defineConfig, devices } from "@playwright/test";
import { loadEnv } from "vite";

Object.assign(process.env, loadEnv("", process.cwd(), ""));

const PORT = 3200;
const baseURL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  retries: 0,
  reporter: "list",
  globalSetup: "./tests/e2e/global-setup.ts",
  globalTeardown: "./tests/e2e/global-teardown.ts",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  webServer: {
    command: `npm run dev -- -p ${PORT}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        storageState: "tests/e2e/.auth/user.json",
      },
      dependencies: ["setup"],
    },
  ],
});
