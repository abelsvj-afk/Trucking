import type { Metadata } from "next";
import NewLoadView from "./view";

export const metadata: Metadata = { title: "Add load — Trucking OS" };

export default function NewLoadPage() {
  return <NewLoadView />;
}
