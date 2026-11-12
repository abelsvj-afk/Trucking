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
import { isPublicSiteRequest } from "@/lib/public-site";

// /api/internal/* (the industry-intelligence manual-trigger debug route,
// docs/runtime.md) is deliberately public here too - it has no user
// session to check against (an unattended job's own credential, not a
// browser login), and enforces its own secret-header check instead
// (INDUSTRY_BRIEFING_CRON_SECRET), same as /api/v1/health being safely
// public because it does nothing sensitive.
//
// Account recovery (added per the owner's request): /forgot-password
// has no session yet by definition, and /auth/confirm is the link the
// recovery email itself points to - it must be reachable with zero
// session or the whole flow can never start. /reset-password is
// deliberately NOT listed here: reaching it requires the session
// /auth/confirm just established (a real, if freshly-issued, session -
// verifyOtp signs the user in), so the existing "no user -> /login"
// redirect below already does the right thing for a stale/invalid/
// already-used recovery link, without any extra logic.
// /api/v1/position/feed (the native background-tracking shell, docs/design/background-tracking.md):
// no browser session exists in native background code; the route enforces its own device-token
// check (Bearer tdv_..., hashed in device_tokens) and fails closed. Only this one path is public.
// /api/v1/position/clocks (the Tracker's floating HOS overlay, docs/design/eld-roadside-overlay.md):
// the same device token, the same fail-closed route-level check; it only READS the server's HOS
// clocks for the token's own company. Public here for exactly the same reason as the feed.
// /api/telegram (the owner's private-bot webhook, docs/design/driver-mvp.md
// §4) is public here for the same reason as /api/internal: Telegram's
// servers have no user session; the route enforces its own webhook
// secret + chat-id allowlist and fails closed without a bot token.
// /sw.js and /manifest.webmanifest (PWA installability, owner report
// 2026-11-07): Chrome's install check runs signed-out, so if these two
// static files redirect to /login the browser concludes the app
// "cannot be installed" even for a signed-in owner. They carry no
// data - the worker script and the manifest are identical for every
// visitor - so they are public like the icon files (which the matcher
// below already exempts from this proxy entirely). ONLY these two
// exact asset paths are added; no page, API route, or data path is
// widened. /public-site is listed as well: it is the internal rewrite
// target that serves the public website on the bare domain (see the
// public-site block at the top of proxy() below) — the route only
// answers requests the proxy marked, and 404s everything else.
const PUBLIC_PATHS = ["/login", "/forgot-password", "/auth/confirm", "/api/v1/health", "/api/internal", "/api/telegram", "/api/v1/position/feed", "/api/v1/position/clocks", "/sw.js", "/manifest.webmanifest", "/public-site"];

export async function proxy(request: NextRequest) {
  // Public website on the bare domain (owner ruling 2026-11-10):
  // roadtolegacytrucking.com and www.roadtolegacytrucking.com serve
  // the public one-page website (src/app/public-site); the app lives
  // on app.roadtolegacytrucking.com. DNS and Fly certificates already
  // point all three hostnames at this one deployment, so the split is
  // made here, before any session work — a public visitor has no
  // session to refresh, and the app's auth gate must never redirect
  // the public page to /login.
  //
  // The check reads the request's HOST header (the hostname the
  // client actually addressed), never request.nextUrl.hostname: the
  // service worker's install fetch is same-origin BY URL on the app
  // host even when a public-host page triggered the install, and
  // keying on the URL would rewrite that fetch too. The navigation
  // test (method + sec-fetch-dest, see src/lib/public-site.ts) keeps
  // the split to genuine page loads for the same reason: the worker's
  // install fetch of "/" is a subresource fetch, and if it ever
  // received the public page while installing from the app, the app
  // shell cache would be poisoned with the marketing page. public/
  // sw.js carries the matching note on its side.
  if (
    isPublicSiteRequest(
      request.headers.get("host"),
      request.method,
      request.headers.get("sec-fetch-dest"),
    )
  ) {
    const url = request.nextUrl.clone();
    url.pathname = "/public-site";
    const headers = new Headers(request.headers);
    // The route answers only proxy-marked requests; the marker also
    // keeps a rewrite loop impossible (the rewritten request's path
    // is /public-site on a public host, which lands back here).
    headers.set("x-public-site-rewrite", "1");
    return NextResponse.rewrite(url, { request: { headers } });
  }

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
