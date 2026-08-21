// Vitest doesn't auto-load .env.local the way Next.js does, and doesn't
// resolve the tsconfig "@/*" path alias on its own either - without both,
// tests/integration/rls-tenant-isolation.test.ts would silently skip
// itself even with real credentials present, and any test importing
// from "@/..." (e.g. tests/unit/services/api/handler.test.ts) would fail
// to resolve. Vite's own loadEnv and resolve.alias are the standard fix
// for each.
import path from "node:path";
import { configDefaults, defineConfig } from "vitest/config";
import { loadEnv } from "vite";

export default defineConfig({
  test: {
    env: loadEnv("", process.cwd(), ""),
    // tests/e2e (task 5.2) runs under Playwright's own test runner, not
    // Vitest - its *.spec.ts files use @playwright/test's `test`, which
    // errors ("did not expect test() to be called here") if Vitest's
    // default include glob (which matches *.spec.ts too, not just
    // *.test.ts) picks them up. Extending configDefaults.exclude rather
    // than replacing it outright so Vitest's own standard exclusions
    // (node_modules, dist, etc.) still apply.
    exclude: [...configDefaults.exclude, "tests/e2e/**"],
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
});
