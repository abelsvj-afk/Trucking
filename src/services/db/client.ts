// Task 1.6 (TASKS.md). Browser-side Supabase client, for use inside Client
// Components. Same anon key + RLS story as server.ts - see that file's
// comment. Never import this from server-only code; use server.ts there.

import { createBrowserClient } from "@supabase/ssr";

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
