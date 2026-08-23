import type { Metadata } from "next";
import NewExpenseView from "./view";

export const metadata: Metadata = { title: "Add expense — Trucking OS" };

export default function NewExpensePage() {
  return <NewExpenseView />;
}
