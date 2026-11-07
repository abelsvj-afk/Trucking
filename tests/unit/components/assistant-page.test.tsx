// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

afterEach(() => {
  cleanup();
});

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/api-client", () => ({
  apiClient: {
    assistantHistory: vi.fn(),
    assistantChat: vi.fn(),
  },
  ApiClientError: class MockApiClientError extends Error {
    code = "TEST";
    status = 500;
  },
}));

import { apiClient } from "@/lib/api-client";
import AssistantPage from "@/app/(app)/more/assistant/page";

const history = Array.from({ length: 30 }, (_, i) => ({
  role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
  text: `turn ${i}`,
}));

// jsdom has no layout: give the conversation box a fixed geometry so
// the stick-to-bottom arithmetic runs on real numbers. scrollTop is
// a plain stored property in jsdom, so the component's own writes
// are what the assertions read back.
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList?.contains("chat-scroll") ? 1000 : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList?.contains("chat-scroll") ? 100 : 0;
    },
  });
  vi.mocked(apiClient.assistantHistory).mockResolvedValue({ data: history, pending_summary: null });
  vi.mocked(apiClient.assistantChat).mockResolvedValue({ reply: "reply text", pending_summary: null });
});

function scrollBox(container: HTMLElement): HTMLElement {
  const el = container.querySelector(".chat-scroll");
  if (!el) throw new Error("chat-scroll missing");
  return el as HTMLElement;
}

describe("Assistant tab - fixed window, stationed composer, stick to bottom", () => {
  it("opens on the newest message: the scroll box is pinned to the bottom after history loads", async () => {
    const { container } = render(<AssistantPage />);
    await screen.findByText("turn 29");
    const box = scrollBox(container);
    expect(box.scrollTop).toBe(900);
    expect(box.scrollTop + 100).toBe(1000);
  });

  it("the composer is stationed outside the scrolling box, below it in the same window", async () => {
    const { container } = render(<AssistantPage />);
    await screen.findByText("turn 29");
    const win = container.querySelector(".chat-window");
    const box = scrollBox(container);
    const dock = container.querySelector(".chat-dock");
    expect(win).not.toBeNull();
    expect(dock).not.toBeNull();
    // the dock (with the message form) is NOT inside the scroller -
    // scrolling the conversation can never carry the composer away
    expect(box.contains(dock)).toBe(false);
    expect(win!.contains(box)).toBe(true);
    expect(win!.contains(dock)).toBe(true);
    expect(dock!.querySelector("form")).not.toBeNull();
    expect(screen.getByLabelText("Message")).toBeTruthy();
  });

  it("his own send lands at the bottom even after he scrolled up to read", async () => {
    const { container } = render(<AssistantPage />);
    await screen.findByText("turn 29");
    const box = scrollBox(container);
    // he scrolls up to read history
    box.scrollTop = 0;
    fireEvent.scroll(box);
    // and sends from there
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "hello king" } });
    fireEvent.submit(container.querySelector(".chat-dock form")!);
    await screen.findByText("reply text");
    expect(box.scrollTop).toBe(900);
  });

  it("a reply that lands while he is scrolled up does not yank him down", async () => {
    let resolveChat: ((v: { reply: string; pending_summary: null }) => void) | null = null;
    vi.mocked(apiClient.assistantChat).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveChat = resolve;
        }),
    );
    const { container } = render(<AssistantPage />);
    await screen.findByText("turn 29");
    const box = scrollBox(container);
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "hello king" } });
    fireEvent.submit(container.querySelector(".chat-dock form")!);
    await screen.findByText("hello king");
    // his send pinned him; while the reply is in flight he scrolls up
    expect(box.scrollTop).toBe(900);
    box.scrollTop = 0;
    fireEvent.scroll(box);
    await act(async () => {
      resolveChat!({ reply: "late reply", pending_summary: null });
    });
    await screen.findByText("late reply");
    expect(box.scrollTop).toBe(0);
  });
});
