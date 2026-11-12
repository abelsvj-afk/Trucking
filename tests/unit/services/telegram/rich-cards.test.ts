// Telegram rich cards (owner 2026-11-11): SAME words, better display.
// Pure presentation helpers - detect a summary card in Abel's
// already-cleaned plain reply, render it as Telegram HTML, and
// build the inline keyboard that rides on it. Nothing here changes
// a word, a digit, or a decision.

import { describe, expect, it } from "vitest";
import {
  buildCardKeyboard,
  detectCard,
  formatCardHtml,
  getTelegramAppUrl,
  TELEGRAM_CAPTION_LIMIT,
  TELEGRAM_MESSAGE_LIMIT,
} from "@/services/telegram/cards";
import {
  clearCardRegistry,
  forgetCardMessage,
  lookupCardMessage,
  recordCardMessage,
  CARD_EDIT_MAX_AGE_MS,
} from "@/services/telegram/card-messages";
import { renderSummaryCardPng } from "@/services/telegram/card-image";

const LOAD_REPLY = [
  "🚚 Load: Trip 1874",
  "",
  "🚚 Route: Panama City, FL → Seminole, OK",
  "📅 Pickup: Nov 10, 8:00 AM",
  "📅 Delivery: Nov 12, 12:00 PM",
  "💵 Pay: $611.20",
  "🛣️ Miles: 1,111",
].join("\n");

const PAY_REPLY = [
  "💵 Pay this week",
  "",
  "💵 Gross: $1,700.00",
  "💵 Net: $1,250.00",
  "📅 Payday: Friday, Nov 20",
].join("\n");

const HOS_REPLY = [
  "🕒 Hours of service",
  "",
  "🕒 Drive left: 6h 12m",
  "🕒 14-hour window: 4h 30m left",
  "🕒 Next break: in 2h",
].join("\n");

describe("detectCard", () => {
  it("detects a load summary and keys it by trip number", () => {
    expect(detectCard(LOAD_REPLY)).toEqual({ kind: "load", key: "load:1874", tripNumber: "1874" });
  });

  it("detects a pay summary", () => {
    const card = detectCard(PAY_REPLY);
    expect(card?.kind).toBe("pay");
    expect(card?.key).toBe("pay:latest");
  });

  it("detects an HOS summary and keys it by today's date (America/New_York)", () => {
    const card = detectCard(HOS_REPLY);
    expect(card?.kind).toBe("hos");
    expect(card?.key).toMatch(/^hos:\d{4}-\d{2}-\d{2}$/);
  });

  it("does not card-ify ordinary prose, questions, or a verbatim-looking read", () => {
    expect(detectCard("You have 3h left.")).toBeNull();
    expect(detectCard("How much is the load paying?")).toBeNull();
    // A document read back word for word has no card header.
    expect(
      detectCard("RATE CONFIRMATION\nLoad 1874\nPanama City, FL to Seminole, OK\nRate: $1,700.00"),
    ).toBeNull();
    // One labeled line is not a summary card.
    expect(detectCard("🚚 Load: Trip 1874")).toBeNull();
  });

  it("does not card-ify a dispatch draft he is meant to send on", () => {
    expect(
      detectCard("Hi, confirming pickup for Trip 1874 tomorrow at 8 AM. Thanks!"),
    ).toBeNull();
  });
});

describe("formatCardHtml", () => {
  it("bolds the header and the labels and changes no words or figures", () => {
    const html = formatCardHtml(LOAD_REPLY);
    expect(html).toContain("<b>🚚 Load: Trip 1874</b>");
    expect(html).toContain("<b>💵 Pay:</b> $611.20");
    expect(html).toContain("<b>🛣️ Miles:</b> 1,111");
    expect(html).toContain("Panama City, FL → Seminole, OK");
    expect(html).not.toContain("*");
  });

  it("escapes HTML metacharacters instead of letting them break the message", () => {
    const html = formatCardHtml("💵 Pay this week\n\n💵 Gross: $1,700.00 <b>not bold</b> & done");
    expect(html).toContain("&lt;b&gt;not bold&lt;/b&gt; &amp; done");
    expect(html).not.toContain("<b>not bold</b>");
  });

  it("is plain-text safe: stripping the tags returns the original words", () => {
    const html = formatCardHtml(PAY_REPLY);
    const stripped = html.replace(/<\/?b>/g, "");
    expect(stripped).toBe(PAY_REPLY);
  });
});

describe("getTelegramAppUrl", () => {
  it("defaults to the live app domain and honors TELEGRAM_APP_URL", () => {
    expect(getTelegramAppUrl({} as NodeJS.ProcessEnv)).toBe("https://app.roadtolegacytrucking.com");
    expect(getTelegramAppUrl({ TELEGRAM_APP_URL: "https://trucking.fly.dev/" } as unknown as NodeJS.ProcessEnv)).toBe(
      "https://trucking.fly.dev",
    );
  });
});

describe("buildCardKeyboard", () => {
  it("a load card opens the Loads page in-app and offers Dismiss", () => {
    const keyboard = buildCardKeyboard(
      { kind: "load", key: "load:1874", tripNumber: "1874" },
      { appUrl: "https://app.roadtolegacytrucking.com", proposal: false },
    );
    const flat = keyboard.flat();
    const webApp = flat.find((b) => b.web_app);
    expect(webApp?.text).toContain("Open in app");
    expect(webApp?.web_app?.url).toBe("https://app.roadtolegacytrucking.com/loads");
    expect(flat.some((b) => b.callback_data === "dismiss:load:1874")).toBe(true);
    // No command-like buttons, no write buttons: answers only.
    expect(flat.every((b) => !b.callback_data?.startsWith("/"))).toBe(true);
  });

  it("a pay card opens the Pay page; an HOS card opens the HOS page", () => {
    const pay = buildCardKeyboard({ kind: "pay", key: "pay:latest" }, { appUrl: "https://app.roadtolegacytrucking.com", proposal: false });
    expect(pay.flat().find((b) => b.web_app)?.web_app?.url).toBe(
      "https://app.roadtolegacytrucking.com/money/pay",
    );
    const hos = buildCardKeyboard({ kind: "hos", key: "hos:2026-11-11" }, { appUrl: "https://app.roadtolegacytrucking.com", proposal: false });
    expect(hos.flat().find((b) => b.web_app)?.web_app?.url).toBe(
      "https://app.roadtolegacytrucking.com/fleet/hos",
    );
  });

  it("a proposal card carries inline Yes / No taps (the typed yes/no, not a command) plus Dismiss", () => {
    const keyboard = buildCardKeyboard(
      { kind: "load", key: "load:1874", tripNumber: "1874" },
      { appUrl: "https://app.roadtolegacytrucking.com", proposal: true },
    );
    const flat = keyboard.flat();
    expect(flat.some((b) => b.callback_data === "yn:yes")).toBe(true);
    expect(flat.some((b) => b.callback_data === "yn:no")).toBe(true);
    expect(flat.some((b) => b.callback_data === "dismiss:load:1874")).toBe(true);
  });

  it("callback_data stays inside Telegram's 64-byte limit", () => {
    const keyboard = buildCardKeyboard(
      { kind: "load", key: "load:1874", tripNumber: "1874" },
      { appUrl: "https://app.roadtolegacytrucking.com", proposal: true },
    );
    for (const button of keyboard.flat()) {
      if (button.callback_data) expect(Buffer.byteLength(button.callback_data)).toBeLessThanOrEqual(64);
    }
  });
});

describe("card message registry (edit-in-place, no migration)", () => {
  it("records and looks up a live card message by chat + key, and forgets it on dismiss", () => {
    clearCardRegistry();
    expect(lookupCardMessage(4242, "load:1874")).toBeUndefined();
    recordCardMessage(4242, "load:1874", 99, "<b>🚚 Load</b>");
    const ref = lookupCardMessage(4242, "load:1874");
    expect(ref?.messageId).toBe(99);
    expect(ref?.sentAtMs).toBeLessThanOrEqual(Date.now());
    forgetCardMessage(4242, "load:1874");
    expect(lookupCardMessage(4242, "load:1874")).toBeUndefined();
  });

  it("the edit window is Telegram's 48 hours", () => {
    expect(CARD_EDIT_MAX_AGE_MS).toBe(48 * 60 * 60 * 1000);
  });
});

describe("renderSummaryCardPng (sharp, already in deps)", () => {
  it("renders a real PNG from the card's title and rows", async () => {
    const png = await renderSummaryCardPng("🚚 Load: Trip 1874", [
      ["Route", "Panama City, FL → Seminole, OK"],
      ["Pay", "$611.20"],
      ["Miles", "1,111"],
    ]);
    expect(png).not.toBeNull();
    // PNG magic bytes.
    expect([...png!.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png!.length).toBeGreaterThan(1000);
  });

  it("never throws on hostile input - a failed render is null, and the text card still goes out", async () => {
    const png = await renderSummaryCardPng("", []);
    expect(png === null || Buffer.isBuffer(png)).toBe(true);
  });
});

describe("Telegram size limits used by the card send path", () => {
  it("pins the limits the code enforces", () => {
    expect(TELEGRAM_MESSAGE_LIMIT).toBe(4096);
    expect(TELEGRAM_CAPTION_LIMIT).toBe(1024);
  });
});
