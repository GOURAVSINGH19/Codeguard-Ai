import { getLLMConfig, type LLMConfig } from "@codeguard/config";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LLMResult {
  content: string;
  usage: LLMUsage | null;
}

/**
 * Anything that can turn chat messages into a JSON string. Groq and OpenAI are
 * implemented by `OpenAICompatibleProvider`; Bedrock or a local model can be
 * added by implementing this interface.
 */
export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  completeJSON(messages: ChatMessage[]): Promise<LLMResult>;
}

export class LLMError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = "LLMError";
  }
}

export interface OpenAICompatibleOptions {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  /** Extra attempts after the first one for 429/5xx/network errors. */
  maxRetries?: number;
  temperature?: number;
  fetchImpl?: typeof fetch;
  /** Injected for tests so backoff doesn't actually wait. */
  sleep?: (ms: number) => Promise<void>;
}

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

/** Chat-completions client for any OpenAI-compatible API (Groq, OpenAI, …). */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly name: string;
  readonly model: string;
  private readonly opts: Required<Omit<OpenAICompatibleOptions, "fetchImpl" | "sleep">> & {
    fetchImpl?: typeof fetch;
    sleep: (ms: number) => Promise<void>;
  };

  constructor(opts: OpenAICompatibleOptions) {
    this.name = opts.name;
    this.model = opts.model;
    this.opts = {
      timeoutMs: 60_000,
      maxRetries: 3,
      temperature: 0.2,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      ...opts,
    };
  }

  static fromConfig(config: LLMConfig = getLLMConfig()): OpenAICompatibleProvider {
    return new OpenAICompatibleProvider({
      name: config.provider,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      timeoutMs: config.timeoutMs,
    });
  }

  async completeJSON(messages: ChatMessage[]): Promise<LLMResult> {
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        return await this.once(messages);
      } catch (err) {
        const retryable = err instanceof LLMError ? err.retryable : true;
        if (!retryable || attempt >= this.opts.maxRetries) throw err;
        const retryAfterMs = (err as { retryAfterMs?: number }).retryAfterMs;
        const backoff = retryAfterMs ?? Math.min(8_000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
        attempt++;
        await this.opts.sleep(backoff);
      }
    }
  }

  private async once(messages: ChatMessage[]): Promise<LLMResult> {
    const fetchFn = this.opts.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);

    let response: Response;
    try {
      response = await fetchFn(`${this.opts.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.opts.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          response_format: { type: "json_object" },
          temperature: this.opts.temperature,
          messages,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      const aborted = (err as Error)?.name === "AbortError";
      throw new LLMError(
        aborted
          ? `${this.name} request timed out after ${this.opts.timeoutMs}ms`
          : `${this.name} request failed: ${(err as Error)?.message ?? String(err)}`,
        null,
        true
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const error = new LLMError(
        `${this.name} API error (${response.status}): ${text.slice(0, 300)}`,
        response.status,
        RETRYABLE_STATUS.has(response.status)
      );
      const retryAfter = Number(response.headers?.get?.("retry-after"));
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        (error as LLMError & { retryAfterMs?: number }).retryAfterMs = Math.min(retryAfter * 1000, 30_000);
      }
      throw error;
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new LLMError(`${this.name} returned an empty response`, response.status, true);

    return {
      content,
      usage: data.usage
        ? {
            promptTokens: data.usage.prompt_tokens ?? 0,
            completionTokens: data.usage.completion_tokens ?? 0,
            totalTokens: data.usage.total_tokens ?? 0,
          }
        : null,
    };
  }
}
