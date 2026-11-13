import { LLMError, type LLMProvider, type LLMRequest, type LLMResponse } from "./types";

/**
 * Groq and OpenAI both speak the OpenAI "chat completions" format, so one
 * implementation covers both; only the base URL, key and model differ.
 */
export function openAICompatibleProvider(opts: {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
}): LLMProvider {
  return {
    name: opts.name,
    model: opts.model,
    async complete(req: LLMRequest): Promise<LLMResponse> {
      const res = await fetch(`${opts.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 90_000),
        body: JSON.stringify({
          model: opts.model,
          temperature: req.temperature ?? 0.1, // low = consistent reviews
          max_tokens: req.maxTokens ?? 4096,
          ...(req.json ? { response_format: { type: "json_object" } } : {}),
          messages: [{ role: "system", content: req.system }, ...req.messages],
        }),
      });

      if (!res.ok) {
        // Never include the API key; keep only a short slice of the body for debugging.
        const body = (await res.text()).slice(0, 300);
        throw new LLMError(`${opts.name} ${res.status}: ${body}`, res.status);
      }
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { total_tokens?: number };
      };
      const text = json.choices?.[0]?.message?.content;
      if (!text) throw new LLMError(`${opts.name} returned an empty answer`);
      return { text, tokens: json.usage?.total_tokens ?? 0 };
    },
  };
}
