import type { Metadata } from "next";
import DocumentsView from "./view";

export const metadata: Metadata = { title: "Documents — Trucking OS" };

export default function DocumentsPage() {
  return <DocumentsView />;
}
