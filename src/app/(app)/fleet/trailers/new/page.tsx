import type { Metadata } from "next";
import NewTrailerView from "./view";

export const metadata: Metadata = { title: "Add trailer — Trucking OS" };

export default function NewTrailerPage() {
  return <NewTrailerView />;
}
