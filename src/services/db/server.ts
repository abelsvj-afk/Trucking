// Task 1.6 (TASKS.md). Server-side Supabase client for use inside Next.js
// Server Components, Route Handlers, and Server Actions.
//
// Per docs/service-specs.md's services/db spec: this always uses the
// public anon key, never the service-role key, so every query runs under
// the caller's own session and Postgres RLS (supabase/migrations/) applies
// automatically. The service-role key is reserved narrowly for the
// industry-intelligence job (docs/automation.md) - nothing here.

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Called from a Server Component that can't set cookies (no
            // active response to attach them to) - safe to ignore as long
            // as middleware is also refreshing the session, which is a
            // Stage 2 (Authentication) task, not this one.
          }
        },
      },
    },
  );
}
