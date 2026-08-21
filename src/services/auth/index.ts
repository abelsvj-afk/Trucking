// Task 2.1 (TASKS.md). Per docs/service-specs.md: the only code that
// determines who's making a request and what company/role they belong to.

import { createClient } from "@/services/db/server";

export interface AuthContext {
  userId: string;
  companyId: string;
  role: string;
}

/**
 * Resolves the current request's authenticated context, or null.
 *
 * Fails closed, always (docs/service-specs.md): a missing/expired session,
 * or an authenticated auth.users row with no matching user_profiles row,
 * is treated as unauthenticated - never assumed or guessed at.
 */
export async function getAuthContext(): Promise<AuthContext | null> {
  const supabase = await createClient();

  // getUser() (not getSession()) revalidates against Supabase Auth's own
  // server on every call - required for server-side trust, since a
  // locally-decoded session cookie could be tampered with client-side.
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return null;
  }

  const { data: profile, error: profileError } = await supabase
    .from("user_profiles")
    .select("company_id, role")
    .eq("id", user.id)
    .single();

  if (profileError || !profile) {
    return null;
  }

  return {
    userId: user.id,
    companyId: profile.company_id,
    role: profile.role,
  };
}
