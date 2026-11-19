// Dispatch Scout boards: ranking, normalizers, fallback walker.
// A field the board does not give stays null — never guessed. A
// per-mile rate is carried only when the board quoted one: it is
// NEVER derived from a flat total (deriving it rounds, and on a
// long haul the Auditor's recomputation can then disagree by more
// than $1 and drop a real load).
import { describe, expect, it } from "vitest";
import {
  FREE_BOARDS,
  LATER_BOARDS,
  normalizeBoardLoad,
  walkBoards,
} from "@/services/bots/boards";
import type { BoardReadResult } from "@/services/bots/browser-runtime";

function readResult(boardSlug: string, status: BoardReadResult["status"], loads: unknown[], note: string): BoardReadResult {
  return { boardSlug, status, loads, note, readAtIso: new Date().toISOString() };
}

describe("board ranking", () => {
  it("reads the free boards in ranked order: TruLOS, Trucker Path, JustTracking", () => {
    expect(FREE_BOARDS.map((board) => board.slug)).toEqual(["trulos", "trucker-path", "justtracking"]);
  });

  it("lists the later boards with their blocker, and never lists the free three", () => {
    const freeSlugs = FREE_BOARDS.map((board) => board.slug);
    for (const board of LATER_BOARDS) {
      expect(freeSlugs).not.toContain(board.slug);
    }
    const bySlug = new Map(LATER_BOARDS.map((board) => [board.slug, board.blockedBy]));
    expect(bySlug.get("dat")).toMatch(/paid subscription/);
    expect(bySlug.get("truckstop")).toMatch(/paid subscription/);
    expect(bySlug.get("123loadboard")).toMatch(/paid subscription/);
    expect(bySlug.get("trucksmarter")).toMatch(/active MC authority/);
    expect(bySlug.get("uber-freight")).toMatch(/active MC authority/);
    expect(bySlug.get("amazon-relay")).toMatch(/active MC authority/);
    expect(bySlug.get("ch-robinson")).toMatch(/active MC authority/);
    expect(bySlug.get("loadsmart")).toMatch(/active MC authority/);
  });
});

describe("normalizeBoardLoad", () => {
  it("normalizes a valid TruLOS row, with nulls for everything the row does not give", () => {
    const { load, reason } = normalizeBoardLoad("trulos", {
      date: "2026-11-20",
      origin: "Atlanta, GA",
      destination: "Dallas, TX",
      equipment: "Dry Van",
      rate: "$1,850",
      weight: "42000",
    });
    expect(reason).toBeNull();
    expect(load).not.toBeNull();
    if (load === null) return;
    expect(load.boardSlug).toBe("trulos");
    expect(load.origin).toBe("Atlanta, GA");
    expect(load.destination).toBe("Dallas, TX");
    expect(load.pickupDate).toBe("2026-11-20");
    expect(load.equipment).toBe("Dry Van");
    expect(load.rateCents).toBe(185000);
    expect(load.weightLbs).toBe(42000);
    // TruLOS gives no miles column and no broker data: null, never guessed.
    expect(load.loadedMiles).toBeNull();
    expect(load.deadheadMiles).toBeNull();
    expect(load.rateCentsPerLoadedMile).toBeNull();
    expect(load.brokerName).toBeNull();
    expect(load.brokerCreditScore).toBeNull();
    expect(load.brokerDaysToPay).toBeNull();
  });

  it("parses a '$1,850' rate string to integer cents", () => {
    const { load } = normalizeBoardLoad("trulos", { origin: "A", destination: "B", rate: "$1,850" });
    expect(load?.rateCents).toBe(185000);
  });

  it("treats a $0 rate as no rate at all (TruLOS $0 means call-for-rate)", () => {
    const { load } = normalizeBoardLoad("trulos", { origin: "A", destination: "B", rate: "$0" });
    expect(load?.rateCents).toBeNull();
  });

  it("returns null with a plain-words reason for a row with no origin or no destination", () => {
    const noOrigin = normalizeBoardLoad("trulos", { destination: "Dallas, TX", rate: "$1,850" });
    expect(noOrigin.load).toBeNull();
    expect(noOrigin.reason).toMatch(/no origin/);
    const noDestination = normalizeBoardLoad("trulos", { origin: "Atlanta, GA", rate: "$1,850" });
    expect(noDestination.load).toBeNull();
    expect(noDestination.reason).toMatch(/no destination/);
    const notARow = normalizeBoardLoad("trulos", "not a row");
    expect(notARow.load).toBeNull();
    expect(notARow.reason).toMatch(/not a load/);
  });

  it("carries JustTracking broker credit and days-to-pay through", () => {
    const { load } = normalizeBoardLoad("justtracking", {
      origin: "Atlanta, GA",
      destination: "Dallas, TX",
      rate: "$1,850",
      brokerName: "Example Brokerage",
      brokerCreditScore: 92,
      brokerDaysToPay: 21,
    });
    expect(load?.brokerName).toBe("Example Brokerage");
    expect(load?.brokerCreditScore).toBe(92);
    expect(load?.brokerDaysToPay).toBe(21);
  });

  it("carries a quoted per-mile rate exactly as quoted", () => {
    const { load } = normalizeBoardLoad("trucker-path", {
      origin: "Atlanta, GA",
      destination: "Dallas, TX",
      rate: "$2.10/mi",
      loadedMiles: 537,
    });
    expect(load?.rateCents).toBeNull();
    expect(load?.rateCentsPerLoadedMile).toBe(210);
  });

  it("does NOT derive a per-mile rate from a flat total — $1,850 over 537 miles stays null per-mile, flat rate intact", () => {
    const { load } = normalizeBoardLoad("trulos", {
      origin: "Atlanta, GA",
      destination: "Dallas, TX",
      rate: "$1,850",
      loadedMiles: 537,
    });
    expect(load?.rateCents).toBe(185000);
    expect(load?.loadedMiles).toBe(537);
    expect(load?.rateCentsPerLoadedMile).toBeNull();
  });

  it("gives the same stable externalRef for the same row", () => {
    const row = { origin: "Atlanta, GA", destination: "Dallas, TX", date: "2026-11-20", rate: "$1,850" };
    const first = normalizeBoardLoad("trulos", row);
    const second = normalizeBoardLoad("trulos", row);
    expect(first.load?.externalRef).toBe(second.load?.externalRef);
    expect(first.load?.externalRef).toMatch(/^trulos:/);
    const withId = normalizeBoardLoad("trulos", { id: "TL-123", origin: "A", destination: "B" });
    expect(withId.load?.externalRef).toBe("trulos:TL-123");
  });
});

describe("walkBoards", () => {
  it("falls through a blocked first board and still collects the second board's loads", async () => {
    const seen: string[] = [];
    const { loads, boardReports } = await walkBoards(async (board) => {
      seen.push(board.slug);
      if (board.slug === "trulos") {
        return readResult("trulos", "blocked-cloudflare", [], "TruLOS showed a human-check page — no loads were read.");
      }
      if (board.slug === "trucker-path") {
        return readResult("trucker-path", "ok", [{ origin: "Atlanta, GA", destination: "Dallas, TX", rate: "$1,850" }], "Read fine.");
      }
      return readResult("justtracking", "empty", [], "No loads listed.");
    });
    expect(seen).toEqual(["trulos", "trucker-path", "justtracking"]);
    expect(loads).toHaveLength(1);
    expect(loads[0]?.boardSlug).toBe("trucker-path");
    expect(boardReports).toHaveLength(3);
    expect(boardReports[0]?.boardSlug).toBe("trulos");
    expect(boardReports[0]?.status).toBe("blocked-cloudflare");
    expect(boardReports[0]?.loadsSeen).toBe(0);
    expect(boardReports[0]?.note).toMatch(/human-check/);
    expect(boardReports[1]?.loadsSeen).toBe(1);
  });

  it("walks on past an empty board and reports it", async () => {
    const { loads, boardReports } = await walkBoards(async (board) => {
      if (board.slug === "trulos") return readResult("trulos", "empty", [], "No loads listed.");
      if (board.slug === "trucker-path") {
        return readResult("trucker-path", "ok", [{ origin: "A", destination: "B", rate: "$900" }], "Read fine.");
      }
      return readResult("justtracking", "empty", [], "No loads listed.");
    });
    expect(loads).toHaveLength(1);
    expect(boardReports[0]?.status).toBe("empty");
    expect(boardReports[1]?.loadsSeen).toBe(1);
  });

  it("stops after the first usable board when stopAfterFirstUsable is set", async () => {
    const seen: string[] = [];
    const { loads } = await walkBoards(
      async (board) => {
        seen.push(board.slug);
        return readResult(board.slug, "ok", [{ origin: "A", destination: "B", rate: "$900" }], "Read fine.");
      },
      { stopAfterFirstUsable: true },
    );
    expect(seen).toEqual(["trulos"]);
    expect(loads).toHaveLength(1);
  });

  it("walks all boards by default and never throws when the reader does", async () => {
    const { loads, boardReports } = await walkBoards(async (board) => {
      if (board.slug === "trulos") throw new Error("reader blew up");
      return readResult(board.slug, "ok", [{ origin: "A", destination: "B", rate: "$900" }], "Read fine.");
    });
    expect(loads).toHaveLength(2);
    expect(boardReports[0]?.status).toBe("error");
    expect(boardReports[0]?.note).toMatch(/reader blew up/);
  });
});
