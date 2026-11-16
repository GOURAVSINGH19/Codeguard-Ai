import { describe, expect, it, vi } from "vitest";
import { openAICompatibleProvider, retryDelayMs } from "../llm/openai-compatible";

const ok = (text: string) => new Response(JSON.stringify({ choices: [{ message: { content: text } }], usage: { total_tokens: 7 } }), { status: 200 });
const err = (status: number, body: string, headers: Record<string, string> = {}) => new Response(body, { status, headers });

describe("retryDelayMs", () => {
  it("prefers Retry-After, then the 'try again in Xs' hint, then exponential backoff", () => {
    expect(retryDelayMs(429, new Headers({ "retry-after": "3" }), "", 0)).toBe(3000);
    expect(retryDelayMs(429, new Headers(), "Please try again in 4.28s.", 0)).toBe(4530);
    expect(retryDelayMs(429, new Headers(), "Please try again in 120ms", 0)).toBe(370);
    expect(retryDelayMs(503, new Headers(), "overloaded", 2)).toBe(4000);
  });
});

describe("openAICompatibleProvider", () => {
  const base = { name: "groq", baseUrl: "https://x", apiKey: "k", model: "m", maxWaitMs: 1 };

  it("retries a 429 and then succeeds", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(err(429, "try again in 0.001s")).mockResolvedValueOnce(ok("{}"));
    const p = openAICompatibleProvider({ ...base, fetchImpl });
    expect(await p.complete({ system: "s", messages: [{ role: "user", content: "u" }] })).toEqual({ text: "{}", tokens: 7 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 400 (our request is wrong; retrying can't fix it)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(err(400, "bad request"));
    const p = openAICompatibleProvider({ ...base, fetchImpl });
    await expect(p.complete({ system: "s", messages: [] })).rejects.toThrow("groq 400");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxRetries", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => err(429, "slow down"));
    const p = openAICompatibleProvider({ ...base, fetchImpl, maxRetries: 2 });
    await expect(p.complete({ system: "s", messages: [] })).rejects.toThrow("groq 429");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
