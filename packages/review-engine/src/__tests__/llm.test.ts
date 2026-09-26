import { describe, it, expect, vi } from "vitest";
import { OpenAICompatibleProvider, LLMError } from "../llm";

function response(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const ok = response(200, { choices: [{ message: { content: "{}" } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });

function provider(fetchImpl: typeof fetch) {
  return new OpenAICompatibleProvider({
    name: "groq",
    baseUrl: "https://llm.test/v1",
    apiKey: "k",
    model: "m",
    fetchImpl,
    sleep: async () => {},
  });
}

describe("OpenAICompatibleProvider", () => {
  it("retries 429 and 5xx, then succeeds", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(429, { error: "slow down" }, { "retry-after": "1" }))
      .mockResolvedValueOnce(response(503, {}))
      .mockResolvedValueOnce(ok);
    const result = await provider(fetchImpl).completeJSON([{ role: "user", content: "hi" }]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(result.usage?.totalTokens).toBe(5);
  });

  it("does not retry a 400 and does not leak the whole error body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(400, { error: "x".repeat(1_000) }));
    const err = await provider(fetchImpl).completeJSON([]).catch((e) => e);
    expect(err).toBeInstanceOf(LLMError);
    expect(err.retryable).toBe(false);
    expect(err.message.length).toBeLessThan(400);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxRetries", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(500, {}));
    await expect(provider(fetchImpl).completeJSON([])).rejects.toBeInstanceOf(LLMError);
    expect(fetchImpl).toHaveBeenCalledTimes(4); // 1 + 3 retries
  });

  it("sends the key only to its own base URL", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok);
    await provider(fetchImpl).completeJSON([]);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://llm.test/v1/chat/completions");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer k" });
  });
});
