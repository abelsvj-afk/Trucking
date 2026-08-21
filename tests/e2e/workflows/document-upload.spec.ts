// docs/user-stories.md: "attach documents... so that records are
// available when I need them." docs/design/testing.md's e2e list names
// this workflow explicitly alongside the load/financial-summary ones.
import { test, expect } from "@playwright/test";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

test("uploading a document against a truck makes it appear in that record's list", async ({ page }) => {
  const dir = await mkdtemp(path.join(tmpdir(), "e2e-doc-"));
  const filePath = path.join(dir, "e2e-test-document.txt");
  await writeFile(filePath, "e2e test document contents");

  await page.goto("/more/documents");
  // Type already defaults to Truck - just pick the seeded record.
  await page.getByLabel("Record").selectOption({ label: "E2E Truck 1" });
  await page.getByLabel("File").setInputFiles(filePath);
  await page.getByRole("button", { name: "Upload" }).click();

  await expect(page.getByRole("link", { name: "e2e-test-document.txt" })).toBeVisible();
});
