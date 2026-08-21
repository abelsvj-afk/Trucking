// Runs once before any test/project, per playwright.config.ts's
// globalSetup. Seeds a fresh, disposable test company (never the
// owner's real account) - see fixtures/test-data.ts for what and why.
import { seedTestCompany } from "./fixtures/test-data";

export default async function globalSetup() {
  await seedTestCompany();
}
