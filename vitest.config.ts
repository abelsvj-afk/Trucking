// Vitest doesn't auto-load .env.local the way Next.js does, and doesn't
// resolve the tsconfig "@/*" path alias on its own either - without both,
// tests/integration/rls-tenant-isolation.test.ts would silently skip
// itself even with real credentials present, and any test importing
// from "@/..." (e.g. tests/unit/services/api/handler.test.ts) would fail
// to resolve. Vite's own loadEnv and resolve.alias are the standard fix
// for each.
import path from "node:path";
import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";

export default defineConfig({
  test: {
    env: loadEnv("", process.cwd(), ""),
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
});
