import type { Metadata, Viewport } from "next";
import "./globals.css";
import OfflineSupport from "@/components/OfflineSupport";
import { ToastProvider } from "@/components/Toast";
import { THEME_STORAGE_KEY } from "@/lib/theme";
import { readPublicConfigFromEnv, serializePublicConfig } from "@/services/config/public-config";

export const metadata: Metadata = {
  title: "Road to Legacy",
  description: "AI-Powered Transportation Operating System",
  // GAP-07: installable shell + offline capture support.
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/favicon-48.png", sizes: "48x48", type: "image/png" },
      { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#0a0a0a",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Read at render time, not module scope: this HTML is produced by
  // docker-entrypoint.cjs's container-start generate pass, where the
  // real Fly.io secrets exist - unlike the Docker image build, where the
  // client bundle was compiled and NEXT_PUBLIC_* inlining silently
  // produced `undefined`. See services/config/public-config.ts for the
  // full explanation of the bug this fixes.
  const publicConfig = readPublicConfigFromEnv();

  return (
    <html lang="en">
      <body>
        <script
          // Theme init (src/lib/theme.ts; default SETTLED dark
          // 2026-11-10, conformance fix D1): runs before paint so the
          // scheme never flashes wrong. A stored explicit pick wins
          // ("dark"/"light" set data-theme; "auto" removes it and the
          // OS media query decides). Missing or garbage means NO pick
          // was ever made, so the shipped default applies: dark, the
          // approved black-and-gold scheme — set data-theme="dark"
          // rather than leaving the light base tokens in charge.
          dangerouslySetInnerHTML={{
            __html: `try{var t=window.localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(t==="dark"||t==="light"){document.documentElement.dataset.theme=t;}else if(t==="auto"){delete document.documentElement.dataset.theme;}else{document.documentElement.dataset.theme="dark";}}catch(e){document.documentElement.dataset.theme="dark";}`,
          }}
        />
        <script
          // Must run before any client component calls createClient().
          // Placed first in <body> so it executes during initial parse,
          // ahead of hydration and any user interaction.
          dangerouslySetInnerHTML={{
            __html: `window.__TRUCKING_PUBLIC_CONFIG__=${serializePublicConfig(publicConfig)}`,
          }}
        />
        <ToastProvider>{children}</ToastProvider>
        <OfflineSupport />
        {/* UI/UX pass (audit F-1): TruckCrossing/BirdCrossing no longer
            mount here — decorative traffic on a timer has no place on
            working/driving screens. The components are kept in
            src/components/ but mounted nowhere: neither exposes a
            run-once/no-timer mode via props, so there is no safe
            login-only mount without surgery. */}
      </body>
    </html>
  );
}
