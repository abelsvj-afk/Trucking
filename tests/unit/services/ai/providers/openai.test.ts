import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));

vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: createMock } };
  },
}));

import { OpenAiProvider } from "@/services/ai/providers/openai";

const originalKey = process.env.OPENAI_API_KEY;

beforeEach(() => {
  process.env.OPENAI_API_KEY = "test-key";
  createMock.mockReset();
});

afterEach(() => {
  process.env.OPENAI_API_KEY = originalKey;
});

describe("OpenAiProvider", () => {
  it("throws when no API key is configured", () => {
    delete process.env.OPENAI_API_KEY;
    expect(() => new OpenAiProvider()).toThrow("OPENAI_API_KEY is not configured");
  });

  it("sends system/user messages and returns the response content", async () => {
    createMock.mockResolvedValue({ choices: [{ message: { content: '{"status":"ok"}' } }] });
    const provider = new OpenAiProvider();

    const result = await provider.complete({ system: "sys", user: "usr" });

    expect(result).toBe('{"status":"ok"}');
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "usr" },
        ],
        response_format: { type: "json_object" },
      }),
    );
  });

  it("throws when the response has no content", async () => {
    createMock.mockResolvedValue({ choices: [{ message: {} }] });
    const provider = new OpenAiProvider();
    await expect(provider.complete({ system: "s", user: "u" })).rejects.toThrow(
      "OpenAI returned an empty response",
    );
  });

  it("completeWithImage sends the image as a data-URI part and returns the content", async () => {
    createMock.mockResolvedValue({ choices: [{ message: { content: '{"doc_type":"bol"}' } }] });
    const provider = new OpenAiProvider();

    const result = await provider.completeWithImage({
      system: "sys",
      user: "read this",
      imageBase64: "aGVsbG8=",
      mediaType: "image/png",
    });

    expect(result).toBe('{"doc_type":"bol"}');
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          { role: "system", content: "sys" },
          {
            role: "user",
            content: [
              { type: "text", text: "read this" },
              {
                type: "image_url",
                image_url: { url: "data:image/png;base64,aGVsbG8=", detail: "high" },
              },
            ],
          },
        ],
        response_format: { type: "json_object" },
      }),
    );
  });

  it("uses OPENAI_MODEL when set, falling back to the default otherwise", async () => {
    createMock.mockResolvedValue({ choices: [{ message: { content: "{}" } }] });
    process.env.OPENAI_MODEL = "gpt-test-model";
    const provider = new OpenAiProvider();
    await provider.complete({ system: "s", user: "u" });
    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt-test-model" }));
    delete process.env.OPENAI_MODEL;
  });
});
