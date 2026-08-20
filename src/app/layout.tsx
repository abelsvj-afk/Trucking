import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Trucking OS",
  description: "AI-Powered Transportation Operating System",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
