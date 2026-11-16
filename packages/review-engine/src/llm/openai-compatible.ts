import { LLMError, type LLMProvider, type LLMRequest, type LLMResponse } from "./types";

/**
 * How long to wait before retrying a rate-limited (429) or overloaded (5xx) call.
 * Prefer the server's own hint: the Retry-After header, or Groq's
 * "Please try again in 4.28s" in the body. Otherwise back off exponentially.
 */
export function retryDelayMs(status: number, headers: Headers, body: string, attempt: number): number {
  const header = Number(headers.get("retry-after"));
  if (Number.isFinite(header) && header > 0) return header * 1000;
  const hint = /try again in ([\d.]+)\s*(ms|s)/i.exec(body);
  if (hint) return Number(hint[1]) * (hint[2].toLowerCase() === "ms" ? 1 : 1000) + 250;
  return 1000 * 2 ** attempt;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Groq and OpenAI both speak the OpenAI "chat completions" format, so one
 * implementation covers both; only the base URL, key and model differ.
 *
 * Rate limits are normal, not exceptional: the staged pipeline makes several
 * calls per review (3 in parallel), and a free tier allows a few thousand tokens
 * per minute. So 429/5xx are retried with the server's suggested wait.
 */
export function openAICompatibleProvider(opts: {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  maxRetries?: number;
  maxWaitMs?: number;
  fetchImpl?: typeof fetch;
}): LLMProvider {
  const doFetch = opts.fetchImpl ?? fetch;
  const maxRetries = opts.maxRetries ?? 4;
  const maxWaitMs = opts.maxWaitMs ?? 30_000;

  return {
    name: opts.name,
    model: opts.model,
    async complete(req: LLMRequest): Promise<LLMResponse> {
      for (let attempt = 0; ; attempt++) {
        const res = await doFetch(`${opts.baseUrl}/chat/completions`, {
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
          const body = (await res.text()).slice(0, 500);
          const retryable = res.status === 429 || res.status >= 500;
          if (retryable && attempt < maxRetries) {
            const wait = Math.min(maxWaitMs, retryDelayMs(res.status, res.headers, body, attempt));
            await sleep(wait * (0.9 + Math.random() * 0.2)); // jitter: parallel callers don't retry in lockstep
            continue;
          }
          throw new LLMError(`${opts.name} ${res.status}: ${body.slice(0, 300)}`, res.status);
        }

        const json = (await res.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
          usage?: { total_tokens?: number };
        };
        const text = json.choices?.[0]?.message?.content;
        if (!text) throw new LLMError(`${opts.name} returned an empty answer`);
        return { text, tokens: json.usage?.total_tokens ?? 0 };
      }
    },
  };
}
