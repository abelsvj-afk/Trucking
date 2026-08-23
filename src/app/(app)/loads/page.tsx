import type { Metadata } from "next";
import LoadsListView from "./view";

export const metadata: Metadata = { title: "Loads — Trucking OS" };

export default function LoadsListPage() {
  return <LoadsListView />;
}
