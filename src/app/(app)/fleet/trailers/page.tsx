import type { Metadata } from "next";
import TrailersListView from "./view";

export const metadata: Metadata = { title: "Trailers — Trucking OS" };

export default function TrailersListPage() {
  return <TrailersListView />;
}
