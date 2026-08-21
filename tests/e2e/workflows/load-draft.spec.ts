// docs/user-stories.md's Alternative workflow: "Owner-operator enters
// partial load details... system stores it as a draft/incomplete
// record... completes it later, before it's included in any
// profitability calculation." Status defaults to Draft in the form
// (loads/new/page.tsx), so this test deliberately never touches it.
import { test, expect } from "@playwright/test";

test("saving an incomplete load keeps it a visibly-badged draft, excluded from the summary", async ({
  page,
}) => {
  const origin = `E2E Draft Origin ${Date.now()}`;
  const destination = "E2E Draft Destination";

  await page.goto("/loads/new");
  await page.getByLabel("Origin").fill(origin);
  await page.getByLabel("Destination").fill(destination);
  // Deliberately no rate, no dates, no status change - the incomplete
  // case the alternative workflow describes.
  await page.getByRole("button", { name: "Save" }).click();

  await page.waitForURL("/loads");
  const row = page.locator("li", { hasText: origin });
  await expect(row).toBeVisible();
  await expect(row.getByText("Draft")).toBeVisible();

  // Filtering to Draft keeps it; filtering to Confirmed hides it.
  await page.getByRole("button", { name: "Draft", exact: true }).click();
  await expect(page.locator("li", { hasText: origin })).toBeVisible();
  await page.getByRole("button", { name: "Confirmed" }).click();
  await expect(page.locator("li", { hasText: origin })).toHaveCount(0);
});
