import type { Metadata } from "next";
import "./globals.css";
import { TruckCrossing } from "@/components/TruckCrossing";
import { BirdCrossing } from "@/components/BirdCrossing";
import { readPublicConfigFromEnv, serializePublicConfig } from "@/services/config/public-config";

export const metadata: Metadata = {
  title: "Trucking OS",
  description: "AI-Powered Transportation Operating System",
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
          // Must run before any client component calls createClient().
          // Placed first in <body> so it executes during initial parse,
          // ahead of hydration and any user interaction.
          dangerouslySetInnerHTML={{
            __html: `window.__TRUCKING_PUBLIC_CONFIG__=${serializePublicConfig(publicConfig)}`,
          }}
        />
        {children}
        <TruckCrossing />
        <BirdCrossing />
      </body>
    </html>
  );
}
