// Task 2.1/2.3 (TASKS.md). Next.js 16 renamed the middleware.ts file
// convention to proxy.ts (confirmed via nextjs.org/docs/messages/middleware-to-proxy
// rather than assumed from the build's deprecation warning alone). Two
// jobs, per Supabase's standard Next.js SSR pattern: (1) revalidate and
// refresh the session cookie on every request, so a long-lived browser
// session doesn't silently expire mid-use, and (2) redirect unauthenticated
// requests to /login for protected paths - an "optimistic check" per
// Next.js's own guidance for this layer. This is NOT the authoritative
// auth check - that's services/auth + services/api/handler.ts, which every
// business route still goes through regardless of what this file does.

import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// /api/internal/* (the industry-intelligence manual-trigger debug route,
// docs/runtime.md) is deliberately public here too - it has no user
// session to check against (an unattended job's own credential, not a
// browser login), and enforces its own secret-header check instead
// (INDUSTRY_BRIEFING_CRON_SECRET), same as /api/v1/health being safely
// public because it does nothing sensitive.
const PUBLIC_PATHS = ["/login", "/api/v1/health", "/api/internal"];

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const isPublicPath = PUBLIC_PATHS.some((path) =>
    request.nextUrl.pathname.startsWith(path),
  );

  if (!user && !isPublicPath) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  if (user && request.nextUrl.pathname === "/login") {
    return NextResponse.redirect(new URL("/", request.url));
  }

  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
