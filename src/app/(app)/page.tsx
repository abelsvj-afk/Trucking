import type { Metadata } from "next";
import HomeView from "./view";

export const metadata: Metadata = { title: "Home — Trucking OS" };

export default function HomePage() {
  return <HomeView />;
}
