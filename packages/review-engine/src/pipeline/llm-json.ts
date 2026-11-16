import type { z } from "zod";
import type { LLMProvider } from "../llm/types";

/** Pull the first {...} block out of a reply, in case the model wrapped it in text or ```fences```. */
export function extractJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error("no JSON object in the model's answer");
  }
}

/**
 * Ask for JSON, validate with Zod, and repair once:
 *   answer → parse → schema check → (on failure) show the model its answer + the error → try again.
 * JSON mode only guarantees valid JSON; the schema checks the MEANING.
 */
export async function completeJson<S extends z.ZodType>(
  provider: LLMProvider,
  system: string,
  user: string,
  schema: S,
  { maxTokens, temperature }: { maxTokens?: number; temperature?: number } = {},
): Promise<{ data: z.output<S>; tokens: number }> {
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [{ role: "user", content: user }];
  let tokens = 0;
  let lastError = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await provider.complete({ system, messages, json: true, maxTokens, temperature });
    tokens += res.tokens;
    try {
      const parsed = schema.safeParse(extractJson(res.text));
      if (parsed.success) return { data: parsed.data, tokens };
      lastError = parsed.error.message;
    } catch (err) {
      lastError = (err as Error).message;
    }
    messages.push(
      { role: "assistant", content: res.text.slice(0, 8000) },
      { role: "user", content: `Your previous answer failed validation:\n${lastError.slice(0, 1500)}\nReturn the corrected JSON object only.` },
    );
  }
  throw new Error(`model output failed validation twice: ${lastError.slice(0, 300)}`);
}
