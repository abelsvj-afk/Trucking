// Live Location fixes: same gates and dedup as every update, never a chat reply.
import { describe, expect, it, vi } from "vitest";
import { handleTelegramUpdate, type TelegramConfig, type TelegramDeps } from "@/services/telegram/dispatch-bot";

const CONFIG: TelegramConfig = { botToken: "t", webhookSecret: null, allowedChatId: "4242", companyId: "c" };
const loc = { latitude: 28.1, longitude: -81.7, horizontal_accuracy: 10 };
const mk = () => {
  const handleLocation = vi.fn().mockResolvedValue(undefined);
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  return { handleLocation, sendMessage, deps: { sendMessage, getSuggestion: vi.fn(), runChat: vi.fn(), handleLocation } as unknown as TelegramDeps };
};

describe("live location in handleTelegramUpdate", () => {
  it("an edited_message fix goes to handleLocation with the edit time, and gets no reply", async () => {
    const { deps, handleLocation, sendMessage } = mk();
    const r = await handleTelegramUpdate({ update_id: 1, edited_message: { chat: { id: 4242, type: "private" }, location: loc, edit_date: 1_800_000_000 } }, CONFIG, deps);
    expect(r).toBe("location_recorded");
    expect(handleLocation).toHaveBeenCalledWith(loc, 1_800_000_000_000);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("the first share (message.location) counts too", async () => {
    const { deps, handleLocation } = mk();
    await handleTelegramUpdate({ message: { chat: { id: 4242, type: "private" }, location: loc, date: 1_800_000_000 } }, CONFIG, deps);
    expect(handleLocation).toHaveBeenCalledWith(loc, 1_800_000_000_000);
  });

  it("another chat's fix is never recorded", async () => {
    const { deps, handleLocation } = mk();
    expect(await handleTelegramUpdate({ edited_message: { chat: { id: 999, type: "private" }, location: loc } }, CONFIG, deps)).toBe("ignored_not_allowlisted");
    expect(await handleTelegramUpdate({ edited_message: { chat: { id: 4242, type: "group" }, location: loc } }, CONFIG, deps)).toBe("ignored_not_private");
    expect(handleLocation).not.toHaveBeenCalled();
  });

  it("without a handler the fix is ignored; a handler failure never replies or throws", async () => {
    const { deps, sendMessage } = mk();
    const noHandler = { ...deps, handleLocation: undefined } as TelegramDeps;
    const upd = { edited_message: { chat: { id: 4242, type: "private" }, location: loc } };
    expect(await handleTelegramUpdate(upd, CONFIG, noHandler)).toBe("location_ignored");
    const failing = { ...deps, handleLocation: vi.fn().mockRejectedValue(new Error("db")) } as TelegramDeps;
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await handleTelegramUpdate(upd, CONFIG, failing)).toBe("location_ignored");
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
