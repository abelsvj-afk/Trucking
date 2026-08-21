// docs/user-stories.md's Error workflow: "Owner-operator attempts to save
// a record with... an invalid value. System rejects the save and
// explains what's wrong... owner-operator corrects the input and
// resubmits." Uses the one cross-field business rule real enough to
// reach the server uncaught by HTML5 (src/data/schemas/loads.ts):
// delivery_date before pickup_date - the browser can't cross-validate
// two independent <input type="date"> fields on its own, so this
// genuinely exercises the server's rejection path and the exact
// message it returns (services/api/validate.ts surfaces the first Zod
// issue's message verbatim), not just a browser-blocked submit.
import { test, expect } from "@playwright/test";

test("saving a load with delivery before pickup is rejected, then succeeds once fixed", async ({
  page,
}) => {
  const origin = `E2E Error Origin ${Date.now()}`;
  const destination = "E2E Error Destination";

  await page.goto("/loads/new");
  await page.getByLabel("Origin").fill(origin);
  await page.getByLabel("Destination").fill(destination);
  await page.getByLabel("Pickup date").fill("2026-02-10");
  await page.getByLabel("Delivery date").fill("2026-02-01"); // before pickup - invalid
  await page.getByRole("button", { name: "Save" }).click();

  await expect(page.getByRole("alert")).toHaveText("delivery_date must not be before pickup_date.");
  // Still on the form - nothing was silently accepted or dropped.
  await expect(page).toHaveURL("/loads/new");
  await expect(page.getByLabel("Origin")).toHaveValue(origin);

  await page.getByLabel("Delivery date").fill("2026-02-15"); // corrected
  await page.getByRole("button", { name: "Save" }).click();

  await page.waitForURL("/loads");
  await expect(page.getByText(`${origin} → ${destination}`)).toBeVisible();
});
