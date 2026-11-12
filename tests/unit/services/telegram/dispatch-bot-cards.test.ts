// Telegram rich cards in the dispatch path (owner 2026-11-11):
// a load / pay / HOS summary goes out as ONE structured card with
// buttons; a tap does exactly what typing the same answer would do;
// a refresh of the same card edits the message in place instead of
// stacking a fifth copy. Plain text is always the fallback.

import { describe, expect, it, vi } from "vitest";
import {
  handleTelegramUpdate,
  type TelegramConfig,
  type TelegramDeps,
} from "@/services/telegram/dispatch-bot";
import type { TelegramStore } from "@/services/telegram/store";
import { clearCardRegistry } from "@/services/telegram/card-messages";

const CONFIG: TelegramConfig = {
  botToken: "test-token",
  webhookSecret: null,
  allowedChatId: "4242",
  companyId: "company-1",
};

const LOAD_REPLY = [
  "🚚 Load: Trip 1874",
  "",
  "🚚 Route: Panama City, FL → Seminole, OK",
  "📅 Pickup: Nov 10, 8:00 AM",
  "📅 Delivery: Nov 12, 12:00 PM",
  "💵 Pay: $611.20",
  "🛣️ Miles: 1,111",
].join("\n");

const PROPOSAL_CARD_REPLY = `${LOAD_REPLY}\n\nReply YES to record this load, or NO to drop it.`;

function fakeStore() {
  const claimed = new Set<number>();
  return {
    loadHistory: vi.fn().mockResolvedValue([]),
    saveMessage: vi.fn().mockResolvedValue(undefined),
    loadMemories: vi.fn().mockResolvedValue([]),
    saveMemory: vi.fn().mockResolvedValue(undefined),
    loadSnapshot: vi.fn().mockResolvedValue(null),
    storeExchange: vi.fn().mockResolvedValue(undefined),
    claimTelegramUpdate: vi.fn(async (updateId: number) => {
      if (claimed.has(updateId)) return false;
      claimed.add(updateId);
      return true;
    }),
    releaseTelegramUpdate: vi.fn().mockResolvedValue(undefined),
  } as unknown as TelegramStore;
}

type RichDeps = TelegramDeps & {
  sendMessage: ReturnType<typeof vi.fn>;
  sendRichMessage: ReturnType<typeof vi.fn>;
  editMessageText: ReturnType<typeof vi.fn>;
  editMessageReplyMarkup: ReturnType<typeof vi.fn>;
  renderCardImage: ReturnType<typeof vi.fn>;
  answerCallbackQuery: ReturnType<typeof vi.fn>;
  runChat: ReturnType<typeof vi.fn>;
  getSuggestion: ReturnType<typeof vi.fn>;
  sendYesNoMessage: ReturnType<typeof vi.fn>;
};

function cardDeps(): RichDeps {
  clearCardRegistry();
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    getSuggestion: vi.fn(),
    runChat: vi.fn(),
    sendRichMessage: vi.fn().mockResolvedValue(77),
    editMessageText: vi.fn().mockResolvedValue("edited"),
    editMessageReplyMarkup: vi.fn().mockResolvedValue("edited"),
    renderCardImage: vi.fn().mockResolvedValue(null),
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    sendYesNoMessage: vi.fn().mockResolvedValue(undefined),
    appUrl: "https://app.roadtolegacytrucking.com",
    store: fakeStore(),
  } as unknown as RichDeps;
}

function textUpdate(updateId: number, text: string) {
  return {
    update_id: updateId,
    message: { message_id: 1, chat: { id: 4242, type: "private" }, text, date: 1 },
  };
}

function tapUpdate(updateId: number, data: string, messageId = 9) {
  const now = Math.floor(Date.now() / 1000);
  return {
    update_id: updateId,
    callback_query: {
      id: `q-${updateId}`,
      data,
      message: { message_id: messageId, date: now - 30, chat: { id: 4242, type: "private" } },
    },
  };
}

describe("rich cards on the reply path", () => {
  it("a load summary goes out once as an HTML card with Open-in-app + Dismiss - not as plain text", async () => {
    const d = cardDeps();
    d.runChat.mockResolvedValue({ reply: LOAD_REPLY, memory: null });
    await handleTelegramUpdate(textUpdate(200, "how is trip 1874"), CONFIG, d);
    expect(d.sendRichMessage).toHaveBeenCalledTimes(1);
    const [chatId, msg] = d.sendRichMessage.mock.calls[0]!;
    expect(chatId).toBe(4242);
    expect(msg.kind).toBe("text");
    expect(msg.html).toContain("<b>🚚 Load: Trip 1874</b>");
    expect(msg.html).toContain("<b>💵 Pay:</b> $611.20");
    expect(msg.html).not.toContain("*");
    const flat = (msg.keyboard as { text: string; web_app?: { url: string }; callback_data?: string }[][]).flat();
    expect(flat.find((b) => b.web_app)?.web_app?.url).toBe("https://app.roadtolegacytrucking.com/loads");
    expect(flat.some((b) => b.callback_data === "dismiss:load:1874")).toBe(true);
    expect(d.sendMessage).not.toHaveBeenCalled();
  });

  // Cards fix (owner 2026-11-12): a forwarded dispatch that parses
  // to a trip must arrive as a LOAD card with Yes/No buttons, not a
  // wall of text. The workup has no card header of its own, so
  // processTextItems prepends the code-built "🚚 Load — Trip NNNN"
  // header and sendReply detects it.
  it("a forwarded dispatch that parses to a trip goes out as a load card with Yes/No buttons", async () => {
    const d = cardDeps();
    const dispatchText = [
      "NEW TRIP 1874 HAS BEEN ASSIGNED",
      "STOP 1",
      "SHIPPER: Kontoor Panama City",
      "ADDRESS: 1 Seaport Drive, Panama City, FL 32401",
      "APPT: 11/10/2026 08:00 CST",
      "STOP 2",
      "SHIPPER: Kontoor Seminole",
      "ADDRESS: 1400 Wrangler Boulevard West, Seminole, OK 74868",
      "APPT: 11/12/2026 12:00 CST",
    ].join("\n");
    d.getSuggestion.mockResolvedValue({
      suggested_reply: "This is a new load — check the stops below against the dispatch before you approve.",
      recordable_items: [
        {
          tool_name: "set_load_stops",
          args: { trip_number: "1874" },
          source_quote: "NEW TRIP 1874 HAS BEEN ASSIGNED",
          confidence: "high",
        },
      ],
    });
    const stageRecordables = vi.fn().mockResolvedValue({
      proposals: [
        {
          tool: "set_load_stops",
          args: { trip_number: "1874" },
          summary: "Set stops on load Trip 1874: 2 stops",
          batchId: "batch-1",
          sourceQuote: "NEW TRIP 1874 HAS BEEN ASSIGNED",
          confidence: "high",
        },
      ],
      rejected: [],
      blockedByPending: false,
      review: [
        "NEW TRIP 1874 — ready for your review",
        "👤 Broker: ITS Logistics LLC · Ref: 5113964",
        "Stop 1 · PICKUP: Kontoor Panama City",
        "  1 Seaport Drive, Panama City, FL 32401",
        "  Appointment: 11/10/2026 08:00 CST",
        "Stop 2 · DELIVERY: Kontoor Seminole",
        "  1400 Wrangler Boulevard West, Seminole, OK 74868",
        "  Appointment: 11/12/2026 12:00 CST",
        "🛣️ Miles: deadhead 220.29 mi · loaded 890.98 mi · total 1,178.27 mi",
      ].join("\n"),
    });
    const result = await handleTelegramUpdate(
      { update_id: 300, message: { message_id: 1, chat: { id: 4242, type: "private" }, text: dispatchText, forward_date: 123, date: 1 } },
      CONFIG,
      { ...d, stageRecordables },
    );
    expect(result).toBe("replied");
    // The card path, not the plain path.
    expect(d.sendRichMessage).toHaveBeenCalledTimes(1);
    expect(d.sendMessage).not.toHaveBeenCalled();
    const [, msg] = d.sendRichMessage.mock.calls[0]!;
    expect(msg.html).toContain("Trip 1874");
    expect(msg.html).toContain("Kontoor Panama City");
    // Proposal card: Yes/No buttons ride with it.
    const flat = (msg.keyboard as { callback_data?: string }[][]).flat();
    expect(flat.some((b) => b.callback_data === "yn:yes")).toBe(true);
    expect(flat.some((b) => b.callback_data === "yn:no")).toBe(true);
    expect(d.sendYesNoMessage).not.toHaveBeenCalled();
  });

  // Same for an agent-written staged proposal in a chat turn (no
  // forward): the reply asks for his yes on a trip with structured
  // lines, so it gets the header and rides a card too.
  it("an agent-written staged proposal about a trip goes out as a load card", async () => {
    const d = cardDeps();
    d.runChat.mockResolvedValue({
      reply: [
        "I've staged all updates for Trip 1874. Here's what's pending for your yes:",
        "",
        "1. Complete Load: Mark the load from Panama City, FL → Seminole, OK (confirmed, delivery 2026-11-12) as completed, delivered on 2026-11-12.",
        "",
        "2. Attach Document: Attach \"telegram-photo-20261111215931.jpg\" to the load from Panama City, FL → Seminole, OK (confirmed, delivery 2026-11-12).",
        "",
        "Reply YES to confirm, or NO to drop it.",
      ].join("\n"),
      memory: null,
    });
    await handleTelegramUpdate(textUpdate(301, "Bol for trip 1847"), CONFIG, d);
    expect(d.sendRichMessage).toHaveBeenCalledTimes(1);
    expect(d.sendMessage).not.toHaveBeenCalled();
    const [, msg] = d.sendRichMessage.mock.calls[0]!;
    expect(msg.html).toContain("Trip 1874");
    const flat = (msg.keyboard as { callback_data?: string }[][]).flat();
    expect(flat.some((b) => b.callback_data === "yn:yes")).toBe(true);
  });

  // Verbatim guard: a document read back word for word can mention
  // a trip and carry labeled lines, but it never asks for a yes —
  // so it stays plain text, never a card.
  it("a verbatim document read stays plain even when it names a trip and carries labeled lines", async () => {
    const d = cardDeps();
    d.runChat.mockResolvedValue({
      reply: [
        "Here's the BOL for Trip 1874, word for word:",
        "",
        "Shipper: Kontoor Panama City",
        "Consignee: Kontoor Seminole",
        "Miles: 1,178.27",
        "Seal: 4417",
      ].join("\n"),
      memory: null,
    });
    await handleTelegramUpdate(textUpdate(302, "Read the BOL for trip 1874 word for word"), CONFIG, d);
    expect(d.sendRichMessage).not.toHaveBeenCalled();
    expect(d.sendMessage).toHaveBeenCalledTimes(1);
    expect(d.sendMessage.mock.calls[0]![1]).toContain("Shipper: Kontoor Panama City");
  });

  it("a proposal card carries inline Yes / No (the typed answer) and no reply keyboard", async () => {
    const d = cardDeps();
    d.runChat.mockResolvedValue({ reply: PROPOSAL_CARD_REPLY, memory: null });
    await handleTelegramUpdate(textUpdate(201, "record trip 1874"), CONFIG, d);
    expect(d.sendRichMessage).toHaveBeenCalledTimes(1);
    const [, msg] = d.sendRichMessage.mock.calls[0]!;
    const flat = (msg.keyboard as { callback_data?: string }[][]).flat();
    expect(flat.some((b) => b.callback_data === "yn:yes")).toBe(true);
    expect(flat.some((b) => b.callback_data === "yn:no")).toBe(true);
    expect(d.sendYesNoMessage).not.toHaveBeenCalled();
  });

  it("a short card renders as a photo with the full text as its caption - the image adds nothing the text lacks", async () => {
    const d = cardDeps();
    d.renderCardImage.mockResolvedValue(Buffer.from("fake-png"));
    d.runChat.mockResolvedValue({ reply: LOAD_REPLY, memory: null });
    await handleTelegramUpdate(textUpdate(202, "how is trip 1874"), CONFIG, d);
    const [, msg] = d.sendRichMessage.mock.calls[0]!;
    expect(msg.kind).toBe("photo");
    expect(msg.photoPng).toEqual(Buffer.from("fake-png"));
    // The caption IS the card text - every figure the image shows is in the caption too.
    expect(msg.html).toContain("$611.20");
    expect(msg.html).toContain("1,111");
  });

  it("ordinary prose and verbatim reads stay plain text - no card dressing", async () => {
    const d = cardDeps();
    d.runChat.mockResolvedValue({ reply: "You have 3h left.", memory: null });
    await handleTelegramUpdate(textUpdate(203, "how much time"), CONFIG, d);
    expect(d.sendRichMessage).not.toHaveBeenCalled();
    expect(d.sendMessage).toHaveBeenCalledWith(4242, "You have 3h left.");
  });

  it("without the rich deps the card degrades to the same plain text as today", async () => {
    const d = cardDeps();
    delete (d as unknown as Record<string, unknown>).sendRichMessage;
    delete (d as unknown as Record<string, unknown>).renderCardImage;
    d.runChat.mockResolvedValue({ reply: LOAD_REPLY, memory: null });
    await handleTelegramUpdate(textUpdate(204, "how is trip 1874"), CONFIG, d);
    expect(d.sendMessage).toHaveBeenCalledWith(4242, LOAD_REPLY);
  });

  it("a rich send failure falls back to plain text (and the reply keyboard for a proposal)", async () => {
    const d = cardDeps();
    d.sendRichMessage.mockRejectedValue(new Error("telegram down"));
    d.runChat.mockResolvedValue({ reply: PROPOSAL_CARD_REPLY, memory: null });
    await handleTelegramUpdate(textUpdate(205, "record trip 1874"), CONFIG, d);
    expect(d.sendYesNoMessage).toHaveBeenCalledTimes(1);
    expect(d.sendYesNoMessage.mock.calls[0]![1]).toContain("Reply YES");
  });

  it("an over-long card falls back to plain chunked text instead of a broken HTML message", async () => {
    const d = cardDeps();
    const longReply = `${LOAD_REPLY}\n📝 Note: ${"x".repeat(5000)}`;
    d.runChat.mockResolvedValue({ reply: longReply, memory: null });
    await handleTelegramUpdate(textUpdate(206, "how is trip 1874"), CONFIG, d);
    expect(d.sendRichMessage).not.toHaveBeenCalled();
    expect(d.sendMessage).toHaveBeenCalled();
  });
});

describe("edit-in-place: one message per thing", () => {
  it("a refreshed load card edits the original message instead of sending a second one", async () => {
    const d = cardDeps();
    d.runChat.mockResolvedValue({ reply: LOAD_REPLY, memory: null });
    await handleTelegramUpdate(textUpdate(210, "how is trip 1874"), CONFIG, d);
    expect(d.sendRichMessage).toHaveBeenCalledTimes(1);
    const updated = LOAD_REPLY.replace("$611.20", "$615.00");
    d.runChat.mockResolvedValue({ reply: updated, memory: null });
    await handleTelegramUpdate(textUpdate(211, "how is trip 1874 now"), CONFIG, d);
    expect(d.sendRichMessage).toHaveBeenCalledTimes(1);
    expect(d.editMessageText).toHaveBeenCalledTimes(1);
    const [chatId, messageId, html] = d.editMessageText.mock.calls[0]!;
    expect(chatId).toBe(4242);
    expect(messageId).toBe(77);
    expect(html).toContain("$615.00");
  });

  it("an unchanged refresh sends nothing new at all - the card already shows it", async () => {
    const d = cardDeps();
    d.editMessageText.mockResolvedValue("unchanged");
    d.runChat.mockResolvedValue({ reply: LOAD_REPLY, memory: null });
    await handleTelegramUpdate(textUpdate(212, "how is trip 1874"), CONFIG, d);
    const updated = LOAD_REPLY.replace("$611.20", "$615.00");
    d.runChat.mockResolvedValue({ reply: updated, memory: null });
    await handleTelegramUpdate(textUpdate(213, "how is trip 1874"), CONFIG, d);
    expect(d.sendRichMessage).toHaveBeenCalledTimes(1);
    expect(d.editMessageText).toHaveBeenCalledTimes(1);
    expect(d.sendMessage).not.toHaveBeenCalled();
  });

  it("a failed edit falls back to a fresh send instead of losing the update", async () => {
    const d = cardDeps();
    d.editMessageText.mockResolvedValue("failed");
    d.runChat.mockResolvedValue({ reply: LOAD_REPLY, memory: null });
    await handleTelegramUpdate(textUpdate(214, "how is trip 1874"), CONFIG, d);
    const updated = LOAD_REPLY.replace("$611.20", "$615.00");
    d.runChat.mockResolvedValue({ reply: updated, memory: null });
    await handleTelegramUpdate(textUpdate(215, "how is trip 1874"), CONFIG, d);
    expect(d.editMessageText).toHaveBeenCalledTimes(1);
    expect(d.sendRichMessage).toHaveBeenCalledTimes(2);
  });

  it("an identical refresh makes no Telegram call at all", async () => {
    const d = cardDeps();
    d.runChat.mockResolvedValue({ reply: LOAD_REPLY, memory: null });
    await handleTelegramUpdate(textUpdate(218, "how is trip 1874"), CONFIG, d);
    await handleTelegramUpdate(textUpdate(219, "how is trip 1874"), CONFIG, d);
    expect(d.sendRichMessage).toHaveBeenCalledTimes(1);
    expect(d.editMessageText).not.toHaveBeenCalled();
    expect(d.sendMessage).not.toHaveBeenCalled();
  });

  it("a proposal card is never edited in place - it always sends fresh, so a pending yes stays visible", async () => {
    const d = cardDeps();
    d.runChat.mockResolvedValue({ reply: PROPOSAL_CARD_REPLY, memory: null });
    await handleTelegramUpdate(textUpdate(216, "record trip 1874"), CONFIG, d);
    d.runChat.mockResolvedValue({ reply: PROPOSAL_CARD_REPLY, memory: null });
    await handleTelegramUpdate(textUpdate(217, "record trip 1874"), CONFIG, d);
    expect(d.editMessageText).not.toHaveBeenCalled();
    expect(d.sendRichMessage).toHaveBeenCalledTimes(2);
  });
});

describe("card button taps", () => {
  it("a Yes tap runs exactly the typed 'yes' and clears the buttons off the proposal message", async () => {
    const d = cardDeps();
    d.runChat.mockResolvedValue({ reply: "Done - recorded.", memory: null });
    const result = await handleTelegramUpdate(tapUpdate(220, "yn:yes"), CONFIG, d);
    expect(result).toBe("callback_replied");
    expect(d.runChat.mock.calls[0]![0].userText).toBe("yes");
    expect(d.sendMessage).toHaveBeenCalledWith(4242, "Done - recorded.");
    expect(d.editMessageReplyMarkup).toHaveBeenCalledWith(4242, 9, []);
  });

  it("a Dismiss tap removes the keyboard and sends nothing new", async () => {
    const d = cardDeps();
    const result = await handleTelegramUpdate(tapUpdate(221, "dismiss:load:1874"), CONFIG, d);
    expect(result).toBe("callback_replied");
    expect(d.answerCallbackQuery).toHaveBeenCalledWith("q-221", undefined);
    expect(d.editMessageReplyMarkup).toHaveBeenCalledWith(4242, 9, []);
    expect(d.sendMessage).not.toHaveBeenCalled();
    expect(d.runChat).not.toHaveBeenCalled();
  });

  it("after Dismiss, a later refresh of the same card sends fresh instead of resurrecting the dismissed one", async () => {
    const d = cardDeps();
    d.runChat.mockResolvedValue({ reply: LOAD_REPLY, memory: null });
    await handleTelegramUpdate(textUpdate(222, "how is trip 1874"), CONFIG, d);
    expect(d.sendRichMessage).toHaveBeenCalledTimes(1);
    await handleTelegramUpdate(tapUpdate(223, "dismiss:load:1874"), CONFIG, d);
    d.runChat.mockResolvedValue({ reply: LOAD_REPLY, memory: null });
    await handleTelegramUpdate(textUpdate(224, "how is trip 1874"), CONFIG, d);
    expect(d.editMessageText).not.toHaveBeenCalled();
    expect(d.sendRichMessage).toHaveBeenCalledTimes(2);
  });

  it("a malformed dismiss tap answers the spinner and settles nothing", async () => {
    const d = cardDeps();
    const result = await handleTelegramUpdate(tapUpdate(225, "dismiss"), CONFIG, d);
    expect(result).toBe("callback_ignored");
    expect(d.answerCallbackQuery).toHaveBeenCalledWith("q-225", "That button doesn't work anymore.");
    expect(d.editMessageReplyMarkup).not.toHaveBeenCalled();
  });
});
