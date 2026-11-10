// @vitest-environment jsdom

// The day view + the ONE unified editor sheet (spec §2.2): Fix (all
// fields, reason required), "Add a change I forgot" (insert anywhere,
// incl. empty days), Delete (consequence copy + reason sent with the
// delete), the edited annotation + Edit history, the date jump, and
// the ?entry= deep link. Selection stays BY ID under live updates.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

vi.mock("@/lib/api-client", () => ({
  apiClient: {
    update: vi.fn(),
    remove: vi.fn(),
    create: vi.fn(),
    get: vi.fn(),
    list: vi.fn(),
  },
  ApiClientError: class extends Error {
    status = 0;
    code = "";
  },
  MUTATION_EVENT: "trucking:mutation",
}));

import { apiClient } from "@/lib/api-client";
import DayLog from "@/components/hud/DayLog";
import type { DayRow } from "@/lib/day-view";

const TZ = "America/New_York";
// "Now" = 2026-11-03 18:00 New York (23:00Z)
const NOW = Date.parse("2026-11-03T23:00:00Z");
const rows: DayRow[] = [
  { id: "a", duty_status: "sleeper", started_at: "2026-11-03T02:00:00Z", created_at: "2026-11-03T02:00:30Z" }, // 21:00 prev day
  { id: "b", duty_status: "driving", started_at: "2026-11-03T11:00:00Z", created_at: "2026-11-03T11:00:10Z" }, // 06:00
  { id: "c", duty_status: "on_duty", started_at: "2026-11-03T20:00:00Z", created_at: "2026-11-03T22:30:00Z", source: "paper_photo" }, // 15:00
];

function mount(extra: { focusEntryId?: string } = {}) {
  render(<DayLog rows={rows} timeZone={TZ} oldestIso="2026-10-25T04:00:00Z" {...extra} />);
}
const hit = (i: number) => fireEvent.click(document.querySelectorAll(".dg-hit")[i]!);

/** Flush the deferred (setTimeout 0) annotation fetches + their promises. */
async function flushFetches() {
  await act(async () => {
    vi.advanceTimersByTime(5);
    await Promise.resolve();
    await Promise.resolve();
  });
}

function typeReason(label: RegExp | string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  vi.clearAllMocks();
  vi.mocked(apiClient.get).mockImplementation(async (resource: string, id: string) => {
    void resource;
    return { id, edits: [] } as never;
  });
  vi.mocked(apiClient.list).mockResolvedValue({ data: [], page: { limit: 200, offset: 0, total: 0 } } as never);
});

describe("DayLog", () => {
  it("draws today on the carrier's clock with totals, up to now", () => {
    mount();
    expect(screen.getByText("Today · 2026-11-03")).toBeTruthy();
    expect(document.querySelectorAll(".dg-hit")).toHaveLength(3);
    const totals = document.querySelector(".day-totals")!.textContent!;
    expect(totals).toContain("Sleeper berth 6h 00m");
    expect(totals).toContain("Driving 9h 00m");
    expect(totals).toContain("On duty (not driving) 3h 00m");
    expect((screen.getByRole("button", { name: "Next day" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("steps back a day and shows that day's stretches", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Previous day" }));
    expect(screen.getByText("2026-11-02")).toBeTruthy();
    expect(document.querySelectorAll(".dg-hit")).toHaveLength(1); // sleeper from 21:00
  });

  it("jumps to a date by tapping the day title (date picker beside the steppers)", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Jump to a date" }));
    fireEvent.change(screen.getByLabelText("Pick a day"), { target: { value: "2026-11-02" } });
    expect(screen.getByText("2026-11-02")).toBeTruthy();
    expect(document.querySelectorAll(".dg-hit")).toHaveLength(1);
  });
});

describe("DayLog - the unified editor (Fix this entry)", () => {
  it("shows the Original line and saves a status fix ONLY with a reason, carrying it to the API", async () => {
    mount();
    hit(1);
    expect(screen.getByText(/Original:/)).toBeTruthy();
    expect(screen.getByText(/the original is never erased/)).toBeTruthy();
    const save = screen.getByRole("button", { name: "Save fix" }) as HTMLButtonElement;
    fireEvent.click(screen.getByRole("button", { name: "On duty" }));
    // Reason required: save stays disabled until a valid reason exists.
    expect(save.disabled).toBe(true);
    typeReason(/Why are you fixing this/, "Wrong status");
    expect(save.disabled).toBe(false);
    vi.mocked(apiClient.update).mockResolvedValue({} as never);
    await act(async () => fireEvent.click(save));
    expect(apiClient.update).toHaveBeenCalledWith("duty-logs", "b", {
      duty_status: "on_duty",
      edit_reason: "Wrong status",
      edit_source: "app",
    });
    expect(screen.getByText(/Entry fixed/)).toBeTruthy();
  });

  it("moves a start within bounds, on the carrier's clock, with the reason", async () => {
    mount();
    hit(1);
    fireEvent.change(screen.getByLabelText(/Started at/), { target: { value: "2026-11-03T06:37" } });
    typeReason(/Why are you fixing this/, "Wrong time");
    vi.mocked(apiClient.update).mockResolvedValue({} as never);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save fix" })));
    expect(apiClient.update).toHaveBeenCalledWith("duty-logs", "b", {
      started_at: "2026-11-03T11:37:00.000Z",
      edit_reason: "Wrong time",
      edit_source: "app",
    });
  });

  it("refuses to move a start past its neighbour - nothing is sent", async () => {
    mount();
    hit(1);
    fireEvent.change(screen.getByLabelText(/Started at/), { target: { value: "2026-11-03T16:00" } });
    typeReason(/Why are you fixing this/, "Wrong time");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save fix" })));
    expect(screen.getByRole("alert").textContent).toContain("pass the next entry");
    expect(apiClient.update).not.toHaveBeenCalled();
  });

  it("can fix location / notes / load in the same one save", async () => {
    vi.mocked(apiClient.list).mockResolvedValue({
      data: [{ id: "load-1", origin: "Panama City, FL", destination: "Seminole, OK" }],
      page: { limit: 200, offset: 0, total: 1 },
    } as never);
    mount();
    hit(1);
    await flushFetches();
    fireEvent.change(screen.getByLabelText("Location"), { target: { value: "Lynn Haven, FL" } });
    fireEvent.change(screen.getByLabelText("Notes"), { target: { value: "Fuel stop" } });
    fireEvent.change(screen.getByLabelText("Load"), { target: { value: "load-1" } });
    typeReason(/Why are you fixing this/, "Entered late");
    vi.mocked(apiClient.update).mockResolvedValue({} as never);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save fix" })));
    expect(apiClient.update).toHaveBeenCalledWith("duty-logs", "b", {
      location: "Lynn Haven, FL",
      notes: "Fuel stop",
      load_id: "load-1",
      edit_reason: "Entered late",
      edit_source: "app",
    });
  });

  it("a paper-sheet row carries the re-mark reminder and its after-the-fact entry", () => {
    mount();
    hit(2);
    expect(screen.getByText(/your paper sheet still says the old time/)).toBeTruthy();
    expect(screen.getByText(/entered after the fact/i)).toBeTruthy();
  });
});

describe("DayLog - Add a change I forgot (insert mode)", () => {
  it("adds a change at any time with a reason - the hard-coded 'Added from the day view' note is gone", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: /Add a change I forgot/ }));
    fireEvent.click(screen.getByRole("button", { name: "Off duty" }));
    fireEvent.change(screen.getByLabelText(/Time/), { target: { value: "10:15" } });
    const add = screen.getByRole("button", { name: "Add entry" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true); // no reason yet
    typeReason(/Why are you fixing this/, "Forgot to log it");
    expect(add.disabled).toBe(false);
    vi.mocked(apiClient.create).mockResolvedValue({} as never);
    await act(async () => fireEvent.click(add));
    expect(apiClient.create).toHaveBeenCalledWith(
      "duty-logs",
      expect.objectContaining({
        duty_status: "off_duty",
        started_at: "2026-11-03T15:15:00.000Z",
        edit_reason: "Forgot to log it",
        edit_source: "app",
        notes: null,
      }),
    );
    const sent = vi.mocked(apiClient.create).mock.calls[0]![1] as Record<string, unknown>;
    expect(JSON.stringify(sent)).not.toContain("Added from the day view");
  });

  it("is available on an EMPTY day and can start it", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Previous day" }));
    fireEvent.click(screen.getByRole("button", { name: "Previous day" }));
    expect(screen.getByText("Nothing logged on this day.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Add a change I forgot/ }));
    fireEvent.change(screen.getByLabelText("Day"), { target: { value: "2026-11-01" } });
    fireEvent.change(screen.getByLabelText(/Time/), { target: { value: "08:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Driving" }));
    typeReason(/Why are you fixing this/, "Forgot to log it");
    vi.mocked(apiClient.create).mockResolvedValue({} as never);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add entry" })));
    expect(apiClient.create).toHaveBeenCalledWith(
      "duty-logs",
      expect.objectContaining({ duty_status: "driving", started_at: "2026-11-01T13:00:00.000Z" }),
    );
  });

  it("refuses a change in the future", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: /Add a change I forgot/ }));
    fireEvent.change(screen.getByLabelText(/Time/), { target: { value: "23:30" } });
    typeReason(/Why are you fixing this/, "Forgot to log it");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add entry" })));
    expect(screen.getByRole("alert").textContent).toContain("can't be in the future");
    expect(apiClient.create).not.toHaveBeenCalled();
  });
});

describe("DayLog - Delete entry… in the editor", () => {
  it("says which status runs on, requires a reason, and sends it in the DELETE body", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Delete Driving 06:00" }));
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Deleting it makes");
    expect(alert.textContent).toMatch(/sleeper berth run on until/i);
    expect(alert.textContent).toContain("restore it under Deleted");
    const yes = screen.getByRole("button", { name: "Yes, delete it" }) as HTMLButtonElement;
    expect(yes.disabled).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    typeReason(/Why are you deleting this/, "Wrong time");
    expect(yes.disabled).toBe(false);
    await act(async () => fireEvent.click(yes));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/duty-logs/b",
      expect.objectContaining({
        method: "DELETE",
        body: JSON.stringify({ edit_reason: "Wrong time", edit_source: "app" }),
      }),
    );
    expect(screen.getByText(/Entry deleted/)).toBeTruthy();
  });

  it("'Keep it' backs out and deletes nothing", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Delete On duty (not driving) 15:00" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("DayLog - edited annotation + Edit history", () => {
  it("annotates an edited entry and opens its history: what changed, the reason, the original line", async () => {
    vi.mocked(apiClient.get).mockImplementation(async (resource: string, id: string) => {
      void resource;
      if (id !== "b") return { id, edits: [] } as never;
      return {
        id,
        edits: [
          {
            id: "e1",
            company_id: "company-1",
            duty_log_id: "b",
            kind: "update",
            reason: "Wrong time",
            before: { duty_status: "driving", started_at: "2026-11-03T11:20:00.000Z" },
            after: { duty_status: "driving", started_at: "2026-11-03T11:00:00.000Z" },
            source: "app",
            edited_at: "2026-11-03T14:12:00.000Z",
            created_at: "2026-11-03T14:12:00.000Z",
          },
        ],
      } as never;
    });
    mount();
    await flushFetches();
    const annotation = screen.getByRole("button", { name: "Edit history Driving 06:00" });
    expect(annotation.textContent).toContain("Edited 9:12 AM");
    expect(annotation.textContent).toContain("Wrong time");
    fireEvent.click(annotation);
    const history = screen.getByRole("dialog", { name: "Edit history" });
    expect(history.textContent).toContain("Wrong time");
    expect(history.textContent).toContain("Original entry created");
    expect(history.textContent).toContain("in the app");
  });
});

describe("DayLog - deep link ?entry=<id>", () => {
  it("selects the entry BY ID and opens its editor", async () => {
    mount({ focusEntryId: "c" });
    await flushFetches();
    expect(screen.getByRole("dialog", { name: "Fix this entry" })).toBeTruthy();
    expect(screen.getByText(/Original:/).textContent).toContain("On duty (not driving)");
  });
});

describe("DayLog under live updates (pitfall hunt, 2026-11-04)", () => {
  it("an edit panel stays on the ENTRY the driver picked when a new row arrives above it", async () => {
    const { rerender } = render(<DayLog rows={rows} timeZone={TZ} oldestIso="2026-10-25T04:00:00Z" />);
    hit(1); // the 06:00 driving entry, id "b"
    const withNew: DayRow[] = [
      rows[0]!,
      { id: "n", duty_status: "on_duty", started_at: "2026-11-03T07:00:00Z", created_at: "2026-11-03T07:00:05Z" },
      rows[1]!,
      rows[2]!,
    ];
    rerender(<DayLog rows={withNew} timeZone={TZ} oldestIso="2026-10-25T04:00:00Z" />);
    expect(document.querySelectorAll(".dg-hit")).toHaveLength(4);
    fireEvent.click(screen.getByRole("button", { name: "Off duty" }));
    typeReason(/Why are you fixing this/, "Wrong status");
    vi.mocked(apiClient.update).mockResolvedValue({} as never);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save fix" })));
    // Still the driving entry "b" - not whatever now sits at position 1.
    expect(apiClient.update).toHaveBeenCalledWith(
      "duty-logs",
      "b",
      expect.objectContaining({ duty_status: "off_duty" }),
    );
  });

  it("if the picked entry disappears elsewhere, its editor closes and says why - nothing else is editable by accident", () => {
    const { rerender } = render(<DayLog rows={rows} timeZone={TZ} oldestIso="2026-10-25T04:00:00Z" />);
    hit(1);
    rerender(<DayLog rows={[rows[0]!, rows[2]!]} timeZone={TZ} oldestIso="2026-10-25T04:00:00Z" />);
    expect(screen.queryByRole("dialog", { name: "Fix this entry" })).toBeNull();
    expect(screen.getByText(/changed or was removed somewhere else/)).toBeTruthy();
    expect(apiClient.update).not.toHaveBeenCalled();
  });

  it("a neighbour's change doesn't wipe what the driver is typing in this entry's panel", () => {
    const { rerender } = render(<DayLog rows={rows} timeZone={TZ} oldestIso="2026-10-25T04:00:00Z" />);
    hit(0);
    const input = screen.getByLabelText(/Started at/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "2026-11-02T21:15" } });
    rerender(<DayLog rows={[rows[0]!, rows[1]!, { ...rows[2]!, duty_status: "off_duty" }]} timeZone={TZ} oldestIso="2026-10-25T04:00:00Z" />);
    expect((screen.getByLabelText(/Started at/) as HTMLInputElement).value).toBe("2026-11-02T21:15");
  });
});

describe("DayLog - an entry list so a wrong time can be fixed or removed with a big tap", () => {
  it("lists every entry of the day with Fix, History and Delete", () => {
    mount();
    const list = screen.getByRole("list", { name: "Entries on this day" });
    expect(list.textContent).toContain("Driving 06:00");
    expect(list.querySelectorAll("li")).toHaveLength(3);
    expect(screen.getByRole("button", { name: "Delete Driving 06:00" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Fix Driving 06:00" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "History Driving 06:00" })).toBeTruthy();
  });

  it("Fix opens the editor without the delete confirmation open", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Fix Driving 06:00" }));
    expect(screen.getByLabelText(/Started at/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Yes, delete it" })).toBeNull();
  });
});
