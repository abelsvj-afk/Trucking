// The waiting list (docs/design/abel-waiting-list.md). Fictional data throughout.
import { describe, expect, it } from "vitest";
import { commentContradicts, formatWaitingList, groupWaitingRows, parseWaitingAnswers, plainSummary, WAITING_LIST_MARK } from "@/services/bot/waiting-list";

describe("commentContradicts: a correction that contradicts the proposal IS a no (D2)", () => {
  const complete = [{ tool_name: "complete_load" }];
  const duty = (status: string) => [{ tool_name: "log_duty_status", arguments: { duty_status: status } }];

  it("the 2026-11-11 answer: 'It's active not complete' drops the complete-load proposal", () => {
    expect(commentContradicts(complete, "It's active not complete")).toBe(true);
    expect(commentContradicts(complete, "not complete yet")).toBe(true);
    expect(commentContradicts(complete, "still active")).toBe(true);
  });

  it("naming a different duty status contradicts the duty proposal; naming the same one does not", () => {
    expect(commentContradicts(duty("on_duty"), "I'm driving")).toBe(true);
    expect(commentContradicts(duty("on_duty"), "the truck is moving")).toBe(true);
    expect(commentContradicts(duty("on_duty"), "I'm on duty")).toBe(false);
    expect(commentContradicts(duty("driving"), "the truck is moving")).toBe(false);
  });

  it("a plain comment is not a contradiction: it stays waiting", () => {
    expect(commentContradicts(complete, "the date is wrong")).toBe(false);
    expect(commentContradicts(duty("on_duty"), "check the miles")).toBe(false);
    expect(commentContradicts([{ tool_name: "update_load" }], "not complete")).toBe(false);
  });
});

describe("parseWaitingAnswers: his reply to a numbered list, read in code", () => {
  it("an answer per number - the reply that went wrong on 2026-11-11", () => {
    const out = parseWaitingAnswers("1. Yes 2. Yes 3. It's active not complete 4.  Not sure , no", 4);
    expect(out.kind).toBe("items");
    if (out.kind !== "items") return;
    expect(out.answers.get(1)).toEqual({ kind: "yes" });
    expect(out.answers.get(2)).toEqual({ kind: "yes" });
    expect(out.answers.get(3)).toEqual({ kind: "comment", text: "It's active not complete" });
    expect(out.answers.get(4)).toEqual({ kind: "no" });
  });

  it("a comment is never a yes, even when it contains the word", () => {
    const out = parseWaitingAnswers("1. yes but the date is wrong 2. no", 2);
    if (out.kind !== "items") throw new Error("expected items");
    expect(out.answers.get(1)?.kind).toBe("comment");
    expect(out.answers.get(2)).toEqual({ kind: "no" });
  });

  it("short forms", () => {
    expect(parseWaitingAnswers("1 yes, 2 no", 2)).toEqual({ kind: "items", answers: new Map([[1, { kind: "yes" }], [2, { kind: "no" }]]) });
    expect(parseWaitingAnswers("yes to 1 and 2, drop 4", 4)).toEqual({
      kind: "items",
      answers: new Map([[1, { kind: "yes" }], [2, { kind: "yes" }], [4, { kind: "no" }]]),
    });
    expect(parseWaitingAnswers("drop 3", 3)).toEqual({ kind: "items", answers: new Map([[3, { kind: "no" }]]) });
    expect(parseWaitingAnswers("Yes all", 3)).toEqual({ kind: "all", answer: "yes" });
    expect(parseWaitingAnswers("drop all", 3)).toEqual({ kind: "all", answer: "no" });
    expect(parseWaitingAnswers("none of them", 3)).toEqual({ kind: "all", answer: "no" });
  });

  it("anything that does not say WHICH is not an answer: nothing is guessed", () => {
    for (const text of ["yes", "Yes", "no", "ok", "I'm off duty for 19 minutes so far", "How are you", "the trailer number is 5620490", ""]) {
      expect(parseWaitingAnswers(text, 4), text).toEqual({ kind: "none" });
    }
  });

  it("a number that is not on the list voids the whole reply", () => {
    expect(parseWaitingAnswers("1. yes 7. no", 4)).toEqual({ kind: "none" });
    expect(parseWaitingAnswers("drop 9", 4)).toEqual({ kind: "none" });
    expect(parseWaitingAnswers("1. yes 1. no", 4)).toEqual({ kind: "none" });
  });
});

describe("plainSummary: a waiting item in the driver's words", () => {
  it("no UTC, no record ids, no column names, no file names", () => {
    const raw =
      'Update load 11111111-2222-4333-8444-555555555555: pickup_window_start → 2026-11-09T08:00:00-06:00 (was 2026-11-10T14:00:00+00:00); Attach "telegram-photo-20261111215931.jpg" to load Macon, GA → Tulsa, OK (confirmed, delivery 2026-11-12)';
    const out = plainSummary(raw, "America/Chicago");
    expect(out).not.toMatch(/\d{4}-\d{2}-\d{2}T|\+00:00|Z\b/);
    expect(out).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(out).not.toMatch(/_|telegram-photo/);
    expect(out).toContain("pickup window start → Mon Nov 9, 8:00 AM CT (was Tue Nov 10, 8:00 AM CT)");
    expect(out).toContain("Attach the photo to load Macon, GA → Tulsa, OK (confirmed, delivery Thu Nov 12)");
  });

  it("an appointment keeps the clock it was written on, whatever the viewer's zone", () => {
    const out = plainSummary("pickup appt 2026-11-12T06:00:00.000Z (America/Chicago), 5 trip task(s), pickup 2026-11-12", "America/New_York");
    expect(out).toBe("pickup appt Thu Nov 12, 12:00 AM CT, 5 trip tasks, pickup Thu Nov 12");
    expect(plainSummary("appt 2026-11-10 08:00 America/Chicago")).toBe("appt Tue Nov 10, 8:00 AM CT");
  });

  it("an instant with no named clock uses the given zone", () => {
    expect(plainSummary("Duty status: on_duty starting at 2026-11-08T13:40:37.858Z (paper-log helper)", "America/New_York")).toBe(
      "Duty status: on duty starting at Sun Nov 8, 8:40 AM ET",
    );
  });

  it("the stops are said once, not three times", () => {
    const out = plainSummary("Set stops on load Trip 9001 (A → B): now 2 stops (1. PICKUP X; 2. DELIVERY Y), becomes 2 stops: 1. PICKUP X; 2. DELIVERY Z");
    expect(out).toBe("Set stops on load Trip 9001 (A → B): 2 stops: 1. PICKUP X; 2. DELIVERY Z");
  });

  it("money and plain text are left alone", () => {
    expect(plainSummary("Expense: $1,034.00 (repairs)")).toBe("Expense: $1,034.00 (repairs)");
  });
});

describe("the list itself", () => {
  it("is numbered, short, and says how to answer", () => {
    const out = formatWaitingList(["Expense: $11.00 (tolls)", "Expense: $88.00 (repairs)"]);
    expect(out).toContain("1. Expense: $11.00 (tolls)\n2. Expense: $88.00 (repairs)");
    expect(out).toContain(WAITING_LIST_MARK);
  });

  it("groups a batch as one entry, leaves out photo questions and expired proposals, oldest first", () => {
    const now = Date.parse("2026-11-12T12:00:00Z");
    const at = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
    const rows = [
      { id: "old", tool_name: "create_expense", summary: "x", created_at: at(600) },
      { id: "p", tool_name: "photo_purpose", summary: "x", created_at: at(5) },
      { id: "b2", tool_name: "attach_document", summary: "x", created_at: at(20), batch_id: "B", item_number: 2 },
      { id: "b1", tool_name: "create_load", summary: "x", created_at: at(20), batch_id: "B", item_number: 1 },
      { id: "s", tool_name: "create_expense", summary: "x", created_at: at(40) },
    ];
    expect(groupWaitingRows(rows, now, 2 * 3_600_000).map((g) => g.map((r) => r.id))).toEqual([["s"], ["b1", "b2"]]);
  });
});
