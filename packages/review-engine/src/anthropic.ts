import Anthropic from "@anthropic-ai/sdk";
import type { LLMConfig } from "@codeguard/config";
import { LLMError } from "./llm";
import type { ChatMessage, LLMProvider, LLMResult } from "./llm";

export interface AnthropicProviderOptions {
  apiKey: string;
  model: string;
  timeoutMs?: number;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Injected for tests. */
  client?: Pick<Anthropic, "beta">;
}

/**
 * Claude via the official SDK. The SDK retries 408/409/429/5xx and connection
 * errors itself (maxRetries), so this class only maps the outcome.
 *
 * - No `temperature` and no assistant prefill: current models reject both.
 *   JSON shape comes from the system prompt and the engine's repair loop.
 * - Thinking is always on for Opus 5.5, so only `text` blocks are read.
 * - `fallbacks: "default"` lets the API re-run a safety-declined request on a
 *   fallback model inside the same call; a refusal that survives it is a
 *   permanent error (retrying the same diff would decline again).
 */
export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  readonly model: string;
  private readonly client: Pick<Anthropic, "beta">;
  private readonly effort: AnthropicProviderOptions["effort"];

  constructor(opts: AnthropicProviderOptions) {
    this.model = opts.model;
    this.effort = opts.effort;
    this.client = opts.client ?? new Anthropic({ apiKey: opts.apiKey, timeout: opts.timeoutMs ?? 120_000, maxRetries: 3 });
  }

  static fromConfig(config: LLMConfig): AnthropicProvider {
    return new AnthropicProvider({ apiKey: config.apiKey, model: config.model, timeoutMs: config.timeoutMs, effort: config.effort });
  }

  async completeJSON(messages: ChatMessage[]): Promise<LLMResult> {
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const turns = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await this.client.beta.messages.create({
        model: this.model,
        max_tokens: 16_000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        ...(this.effort ? { output_config: { effort: this.effort } } : {}),
        ...(system ? { system } : {}),
        messages: turns,
      });
    } catch (err) {
      if (err instanceof Anthropic.APIError) {
        const status = typeof err.status === "number" ? err.status : null;
        // The SDK already retried the retryable statuses; what reaches us is final
        // for this attempt, but a later Kafka retry may still succeed on 429/5xx.
        const retryable = status === null || status === 429 || status >= 500;
        throw new LLMError(`anthropic API error (${status ?? "network"}): ${err.message.slice(0, 300)}`, status, retryable);
      }
      throw err;
    }

    if (response.stop_reason === "refusal") {
      throw new LLMError(`anthropic declined the request (${response.stop_details?.category ?? "unspecified"})`, 200, false);
    }
    const content = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    if (!content) throw new LLMError(`anthropic returned no text (stop_reason: ${response.stop_reason})`, 200, true);
    if (response.stop_reason === "max_tokens") {
      throw new LLMError("anthropic response was cut off at max_tokens", 200, false);
    }

    const input = response.usage.input_tokens ?? 0;
    const output = response.usage.output_tokens ?? 0;
    return { content, usage: { promptTokens: input, completionTokens: output, totalTokens: input + output } };
  }
}
