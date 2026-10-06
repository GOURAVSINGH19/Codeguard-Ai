import { getLLMConfig, type LLMConfig } from "@codeguard/config";
import { AnthropicProvider } from "./anthropic";
import { OpenAICompatibleProvider } from "./llm";
import type { LLMProvider } from "./llm";

/** The review model selected by LLM_PROVIDER (groq | openai | anthropic). */
export function createLLMProvider(config: LLMConfig = getLLMConfig()): LLMProvider {
  return config.provider === "anthropic" ? AnthropicProvider.fromConfig(config) : OpenAICompatibleProvider.fromConfig(config);
}
