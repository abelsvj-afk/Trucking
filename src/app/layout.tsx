import type { Metadata } from "next";
import "./globals.css";
import { TruckCrossing } from "@/components/TruckCrossing";
import { BirdCrossing } from "@/components/BirdCrossing";

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
      <body>
        {children}
        <TruckCrossing />
        <BirdCrossing />
      </body>
    </html>
  );
}
