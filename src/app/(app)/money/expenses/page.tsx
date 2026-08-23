import type { Metadata } from "next";
import ExpensesListView from "./view";

export const metadata: Metadata = { title: "Expenses — Trucking OS" };

export default function ExpensesListPage() {
  return <ExpensesListView />;
}
