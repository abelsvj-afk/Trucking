// Playwright "setup project" (see playwright.config.ts's `projects`
// array) - runs once, signs in through the real /login UI (not an API
// shortcut, so this itself exercises the actual sign-in workflow) using
// the disposable test user global-setup.ts just seeded, then saves the
// authenticated session so every other spec starts already logged in.
import { test as setup } from "@playwright/test";
import { readTestFixture } from "./fixtures/test-data";

const authFile = "tests/e2e/.auth/user.json";

setup("authenticate", async ({ page }) => {
  const fixture = await readTestFixture();

  await page.goto("/login");
  await page.getByLabel("Email").fill(fixture.email);
  await page.getByLabel("Password").fill(fixture.password);
  await page.getByRole("button", { name: "Sign in" }).click();

  await page.waitForURL("/");
  await page.context().storageState({ path: authFile });
});
