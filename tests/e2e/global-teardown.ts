// Runs once after all tests/projects finish, per playwright.config.ts's
// globalTeardown - deletes everything global-setup.ts seeded so a test
// run never leaves disposable data behind in the real project.
import { destroyTestCompany, readTestFixture } from "./fixtures/test-data";

export default async function globalTeardown() {
  // If global-setup.ts itself failed before writing the fixture (e.g.
  // this sandbox's *.supabase.co network egress block), there's nothing
  // to clean up - surfacing that as a second, confusing ENOENT error on
  // top of the real one would obscure the actual failure, not clarify it.
  let fixture;
  try {
    fixture = await readTestFixture();
  } catch {
    return;
  }
  await destroyTestCompany(fixture);
}
