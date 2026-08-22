// Account recovery, added per the owner's explicit request - this app
// had no way to regain access if a password was ever forgotten. Follows
// Supabase's own current documented pattern for the PKCE flow
// (@supabase/ssr's createBrowserClient uses PKCE, confirmed via
// mcp__Supabase__search_docs rather than assumed from training data,
// since Supabase's docs explicitly warn the implicit-flow instructions
// don't apply once SSR is in use).
//
// This is the link the recovery email itself points to - verifyOtp
// exchanges the one-time token_hash for a real (if freshly-issued)
// session, which is what lets /reset-password work at all: it relies on
// proxy.ts's normal "no session -> /login" redirect rather than its own
// session check, so a valid session has to exist by the time the
// browser gets there.
//
// Real external dependency this route can't self-verify: Supabase's
// default "Reset Password" email template does not emit a token_hash
// link - it must be edited in the Supabase Dashboard (Authentication ->
// Email Templates) to:
//   <a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery&next=/reset-password">Reset password</a>
// No tool in this session's Supabase MCP connector can read or write
// that template - it's an owner action, tracked in PROJECT_STATE.md.

import { type EmailOtpType } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/services/db/server";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const next = searchParams.get("next") ?? "/";

  const redirectTo = request.nextUrl.clone();
  redirectTo.pathname = next;
  redirectTo.search = "";

  if (tokenHash && type) {
    const supabase = await createClient();
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (!error) {
      return NextResponse.redirect(redirectTo);
    }
  }

  // Never a broken/blank page on an invalid or expired link - land back
  // on /login with a plain, actionable message (docs/design/ui-ux.md's
  // Errors section), not a raw error or a dead end.
  redirectTo.pathname = "/login";
  redirectTo.searchParams.set("error", "recovery_link_invalid");
  return NextResponse.redirect(redirectTo);
}
