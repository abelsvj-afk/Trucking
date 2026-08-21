// docs/design/testing.md's e2e list names "view the financial summary"
// as its own workflow, distinct from load-normal.spec.ts's check that a
// specific load's revenue actually lands in it. This covers the two
// summary surfaces docs/design/ui-ux.md describes: the Home snapshot
// (current month, no params) and Money > Summary's explicit date range.
import { test, expect } from "@playwright/test";

test("Home shows the current-month snapshot and Money > Summary shows a chosen range", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByText("This month")).toBeVisible();
  await expect(page.getByText("Revenue")).toBeVisible();
  await expect(page.getByText("Net")).toBeVisible();

  await page.goto("/money/summary");
  await page.getByLabel("From").fill("2020-01-01");
  await page.getByLabel("To").fill("2020-01-31");
  await page.getByRole("button", { name: "View range" }).click();

  // A range with no data in it is a valid, real result - $0.00, not an
  // error - which is itself worth asserting: an empty range must not be
  // confused with a failed request (docs/design/ui-ux.md's States section).
  await expect(page.getByText("2020-01-01")).toBeVisible();
  await expect(page.getByText("$0.00").first()).toBeVisible();
});
