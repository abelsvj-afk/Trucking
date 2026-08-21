// Vitest doesn't auto-load .env.local the way Next.js does - without this,
// tests/integration/rls-tenant-isolation.test.ts would silently skip
// itself even with real credentials present, since process.env would be
// empty. Vite's own loadEnv is the standard fix.
import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";

export default defineConfig({
  test: {
    env: loadEnv("", process.cwd(), ""),
  },
});
