// Runtime public configuration, shared between the server (which injects
// it) and the browser (which reads it back).
//
// Why this exists at all - a real production bug, not a preference:
// `NEXT_PUBLIC_*` values are not read from the environment at runtime in
// the browser. Next.js text-substitutes them into the client JavaScript
// bundle when that bundle is *compiled*. In this project's deployment
// that compile happens inside `Dockerfile`'s
// `next build --experimental-build-mode compile` step - at Docker image
// build time, when Fly.io secrets do not exist (they are injected into
// the running machine, not the builder). Both values therefore compiled
// to `undefined` and stayed that way; `docker-entrypoint.cjs`'s
// container-start `--experimental-build-mode generate` pass only
// regenerates static HTML, it does not recompile the client bundle.
//
// The symptom was that the site loaded fine (server code reads
// `process.env` at runtime, so middleware and API routes worked) while
// every browser-side Supabase call failed with "@supabase/ssr: Your
// project's URL and API key are required to create a Supabase client!".
// Setting or re-setting the Fly secrets could never have fixed it.
//
// The fix: the server reads the values at render time and injects them
// into the HTML (see src/app/layout.tsx), and the browser Supabase
// client reads them back from there (see src/services/db/client.ts).
// That HTML *is* produced with real secrets present, because
// docker-entrypoint.cjs's generate pass runs at container start.
//
// Only genuinely public values belong here - this object is served to
// every visitor in plain HTML. That matches what `NEXT_PUBLIC_*` already
// meant (those values ship inside the client bundle regardless); the
// Supabase URL and publishable/anon key are designed for browser use,
// with row-level security as the actual trust boundary
// (docs/design/security.md). Never add a service-role key, an API
// secret, or a database credential to this object.

export interface PublicConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
}

declare global {
  interface Window {
    __TRUCKING_PUBLIC_CONFIG__?: PublicConfig;
  }
}

/**
 * Server-side: read the public config out of the real runtime
 * environment. Call this during render (not at module scope) so the
 * value comes from the running container's environment rather than
 * whatever happened to be set when the module was first evaluated.
 */
export function readPublicConfigFromEnv(): PublicConfig {
  return {
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
  };
}

/**
 * Serialize the config for embedding in an inline <script>. `<` is
 * escaped so a value can never terminate the script tag early - these
 * values are our own configuration rather than user input, but a
 * server-rendered inline script is exactly where that assumption should
 * not be load-bearing.
 */
export function serializePublicConfig(config: PublicConfig): string {
  return JSON.stringify(config).replace(/</g, "\\u003c");
}

/**
 * Browser-side: the server-injected config, when present. Falls back to
 * build-time inlined values, which is the normal path in local
 * development (`next dev` reads .env.local at compile time, so inlining
 * works there and this indirection is invisible).
 */
export function readPublicConfig(): PublicConfig {
  const injected = typeof window === "undefined" ? undefined : window.__TRUCKING_PUBLIC_CONFIG__;

  return {
    supabaseUrl: injected?.supabaseUrl || process.env.NEXT_PUBLIC_SUPABASE_URL || "",
    supabaseAnonKey:
      injected?.supabaseAnonKey || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "",
  };
}
