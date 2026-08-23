import type { Metadata } from "next";
import NewDriverView from "./view";

export const metadata: Metadata = { title: "Add driver — Trucking OS" };

export default function NewDriverPage() {
  return <NewDriverView />;
}
