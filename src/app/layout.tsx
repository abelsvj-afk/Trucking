import type { Metadata, Viewport } from "next";
import "./globals.css";
import ServiceWorkerRegister from "@/components/ServiceWorkerRegister";
import OfflineSupport from "@/components/OfflineSupport";
import { ToastProvider } from "@/components/Toast";
import { THEME_STORAGE_KEY } from "@/lib/theme";
import { readPublicConfigFromEnv, serializePublicConfig } from "@/services/config/public-config";

export const metadata: Metadata = {
  title: "Trucking OS",
  description: "AI-Powered Transportation Operating System",
  // GAP-07: installable shell + offline capture support.
  manifest: "/manifest.webmanifest",
};

export const viewport: Viewport = {
  themeColor: "#0b1220",
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
          // Theme init (parked decision (d), src/lib/theme.ts): runs
          // before paint so a stored Light/Dark pick never flashes the
          // wrong scheme. Missing or "auto" removes data-theme, which
          // leaves the OS media query in charge of globals.css.
          dangerouslySetInnerHTML={{
            __html: `try{var t=window.localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(t==="dark"||t==="light"){document.documentElement.dataset.theme=t;}else{delete document.documentElement.dataset.theme;}}catch(e){}`,
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
        <ServiceWorkerRegister />
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
