// Task 2.5 (TASKS.md). No auth - the one documented exception in
// docs/api-contracts.md, kept separate from business endpoints per
// CLAUDE.md's diagnostics rule.
import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({ status: "ok" });
}
