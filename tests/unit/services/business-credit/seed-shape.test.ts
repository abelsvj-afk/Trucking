// Migration 00087 seed shape (brief 2026-11-10): the seeded facts are
// exactly the brief's verified facts, nothing is owed at seed time
// (no fake due dates), eCredable is parked, the Quill cart is a note
// (never an order), and there is NO EIN anywhere — no column, no value.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  path.join(process.cwd(), "supabase/migrations/00087_business_credit.sql"),
  "utf8",
);
// Code only (comments stripped) for the structural checks.
const code = sql.replace(/--[^\n]*/g, "");

describe("00087 seed shape", () => {
  it("creates the four tables with RLS tenant isolation", () => {
    for (const t of [
      "page_access_rules",
      "business_credit_profiles",
      "business_credit_accounts",
      "business_credit_events",
    ]) {
      expect(code).toContain(`create table if not exists public.${t}`);
      expect(code).toContain(`alter table public.${t} enable row level security`);
    }
    expect(code).toContain("private.current_company_id()");
  });

  it("flags the Business Credit page owner-only as DATA", () => {
    expect(code).toContain("'/more/business-credit'");
    expect(code).toContain("insert into public.page_access_rules");
  });

  it("seeds the identity header from the brief", () => {
    for (const fact of [
      "SAJACOUS MIXED IT LLC",
      "SAJACOUSMIXEDIT LLC",
      "144-350783",
      "L26000135400",
      "720 N US Highway 441 #1021, Lady Lake, FL 32159",
      "owner@roadtolegacytrucking.com",
    ]) {
      expect(sql).toContain(fact);
    }
  });

  it("seeds all six accounts with their brief facts", () => {
    for (const fact of [
      "'dun-and-bradstreet'",
      "'quill'",
      "'uline'",
      "'ecredable'",
      "'nav'",
      "'bluevine'",
      "Trade Exchange",
      "1-800-295-5510",
      "PARKED until Friday 2026-11-13",
      "$112.06",
      "UNPLACED",
    ]) {
      expect(sql).toContain(fact);
    }
  });

  it("seeds NOTHING owed: the account insert never sets payment fields", () => {
    const accountInsert = code.slice(
      code.indexOf("insert into public.business_credit_accounts"),
    );
    expect(accountInsert).not.toContain("next_due_date");
    expect(accountInsert).not.toContain("amount_due_cents");
    expect(accountInsert).not.toContain("payment_state");
    // And the column defaults are the honest ones.
    expect(code).toContain("payment_state text not null default 'none'");
  });

  it("contains no EIN column or value anywhere", () => {
    expect(code).not.toMatch(/\bein(_number|_tax_id)?\s+(text|varchar|char)/i);
    expect(code).not.toMatch(/'ein'|"ein"/i);
    expect(code).not.toMatch(/\b\d{2}-\d{7}\b/);
  });

  it("dedupe: one watch event per (company, account, email)", () => {
    expect(code).toContain("business_credit_events_watch_uidx");
    expect(code).toContain("(company_id, account_id, email_message_id)");
  });
});
