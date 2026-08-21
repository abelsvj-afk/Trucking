// docs/user-stories.md's Normal workflow: "Owner-operator enters load
// details... appears in the financial summary." Requires status:
// "confirmed" to actually reach the financial summary
// (docs/design/data-model.md - draft is excluded) - the missing UI
// control for this was a real gap found and fixed while building this
// suite (see loads/new/page.tsx's comment).
import { test, expect } from "@playwright/test";

test("recording a complete load appears in the list and the financial summary", async ({ page }) => {
  const origin = `E2E Origin ${Date.now()}`;
  const destination = "E2E Destination";

  await page.goto("/loads/new");
  await page.getByLabel("Origin").fill(origin);
  await page.getByLabel("Destination").fill(destination);
  await page.getByLabel("Pickup date").fill("2026-01-05");
  await page.getByLabel("Delivery date").fill("2026-01-06");
  await page.getByLabel("Rate ($)").fill("1250");
  await page.getByLabel("Status").selectOption("confirmed");
  await page.getByLabel("Truck").selectOption({ label: "E2E Truck 1" });
  await page.getByLabel("Driver").selectOption({ label: "E2E Test Driver" });
  await page.getByRole("button", { name: "Save" }).click();

  await page.waitForURL("/loads");
  await expect(page.getByText(`${origin} → ${destination}`)).toBeVisible();
  // Confirmed loads carry no Draft badge (docs/design/ui-ux.md).
  await expect(page.locator("li", { hasText: origin }).getByText("Draft")).toHaveCount(0);

  await page.goto("/money/summary");
  await page.getByLabel("From").fill("2026-01-01");
  await page.getByLabel("To").fill("2026-01-31");
  await page.getByRole("button", { name: "View range" }).click();
  await expect(page.getByText("$1,250.00")).toBeVisible();
});
