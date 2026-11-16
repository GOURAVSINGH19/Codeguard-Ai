import { openAICompatibleProvider } from "./openai-compatible";
import type { LLMProvider } from "./types";

export * from "./types";

export interface ProviderEnv {
  LLM_PROVIDER: "groq" | "openai";
  LLM_MODEL?: string;
  GROQ_API_KEY?: string;
  OPENAI_API_KEY?: string;
}

/** Defaults; override with LLM_MODEL. Check your provider's console for current model names. */
const DEFAULT_MODELS = {
  groq: "openai/gpt-oss-120b",
  openai: "gpt-4.1-mini",
} as const;

/** Pick the provider from env. Each provider only ever sees its own key. */
export function createProvider(env: ProviderEnv): LLMProvider {
  const model = env.LLM_MODEL ?? DEFAULT_MODELS[env.LLM_PROVIDER];
  switch (env.LLM_PROVIDER) {
    case "groq":
      if (!env.GROQ_API_KEY) throw new Error("LLM_PROVIDER=groq needs GROQ_API_KEY");
      return openAICompatibleProvider({
        name: "groq",
        baseUrl: "https://api.groq.com/openai/v1",
        apiKey: env.GROQ_API_KEY,
        model,
      });
    case "openai":
      if (!env.OPENAI_API_KEY) throw new Error("LLM_PROVIDER=openai needs OPENAI_API_KEY");
      return openAICompatibleProvider({
        name: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: env.OPENAI_API_KEY,
        model,
      });
  }
}
