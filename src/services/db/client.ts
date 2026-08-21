// Task 1.6 (TASKS.md). Browser-side Supabase client, for use inside Client
// Components. Same anon key + RLS story as server.ts - see that file's
// comment. Never import this from server-only code; use server.ts there.
//
// Config comes from services/config/public-config.ts rather than
// straight from process.env: in the deployed container the browser
// bundle was compiled before any Fly.io secret existed, so
// NEXT_PUBLIC_* inlining produced `undefined` and every browser-side
// Supabase call failed. That file documents the bug in full.

import { createBrowserClient } from "@supabase/ssr";
import { readPublicConfig } from "@/services/config/public-config";

export function createClient() {
  const { supabaseUrl, supabaseAnonKey } = readPublicConfig();

  // Fail with a message that names the actual cause. @supabase/ssr's own
  // error ("Your project's URL and API key are required...") sends you
  // to the Supabase dashboard, which is misleading here - the values
  // exist there and in the Fly secrets; what's missing is their delivery
  // into the page. Silent or misdirecting failures are prohibited by
  // CLAUDE.md.
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      "Supabase browser config missing: the server did not inject " +
        "__TRUCKING_PUBLIC_CONFIG__ into the page. Check that " +
        "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are " +
        "set in the running environment (Fly.io secrets in production, " +
        ".env.local locally).",
    );
  }

  return createBrowserClient(supabaseUrl, supabaseAnonKey);
}
