// docs/design/testing.md's Error handling & edge cases: "A failed save
// doesn't lose the form's in-progress data... test that a simulated
// network failure leaves the entered values intact." Maps to
// docs/user-stories.md's Recovery workflow. Uses Playwright's request
// interception to simulate the network failure itself, rather than
// relying on anything actually being down.
import { test, expect } from "@playwright/test";

test("a failed save keeps the entered data in the form, and a retry succeeds", async ({ page }) => {
  const origin = `E2E Recovery Origin ${Date.now()}`;
  const destination = "E2E Recovery Destination";

  await page.goto("/loads/new");
  await page.getByLabel("Origin").fill(origin);
  await page.getByLabel("Destination").fill(destination);

  // Simulate a network failure on the save request only.
  await page.route("**/api/v1/loads", (route) => route.abort("failed"));
  await page.getByRole("button", { name: "Save" }).click();

  await expect(page.getByRole("alert")).toBeVisible();
  // Still on the form, values intact - nothing was lost or reset.
  await expect(page).toHaveURL("/loads/new");
  await expect(page.getByLabel("Origin")).toHaveValue(origin);
  await expect(page.getByLabel("Destination")).toHaveValue(destination);

  // Retry, network restored - the same in-progress data now saves.
  await page.unroute("**/api/v1/loads");
  await page.getByRole("button", { name: "Save" }).click();

  await page.waitForURL("/loads");
  await expect(page.getByText(`${origin} → ${destination}`)).toBeVisible();
});
