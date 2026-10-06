import type { z } from "zod";
import type { ChatMessage, LLMProvider, LLMUsage } from "./llm";

export class ReviewValidationError extends Error {
  constructor(message: string, readonly raw: string) {
    super(message);
    this.name = "ReviewValidationError";
  }
}

export function addUsage(a: LLMUsage | null, b: LLMUsage | null): LLMUsage | null {
  if (!a) return b;
  if (!b) return a;
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

/** Parse + validate model output. Tolerates ```json fences and leading prose. */
export function validateJSON<S extends z.ZodTypeAny>(raw: string, schema: S): z.infer<S> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end <= start) throw new ReviewValidationError("response is not JSON", raw);
    try {
      json = JSON.parse(raw.slice(start, end + 1));
    } catch {
      throw new ReviewValidationError("response is not JSON", raw);
    }
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new ReviewValidationError(`schema mismatch — ${detail}`, raw);
  }
  return parsed.data;
}

/** Call the model and validate its JSON, with up to `maxRepairAttempts` repair turns. */
export async function completeStructured<T>(
  llm: LLMProvider,
  messages: ChatMessage[],
  parse: (raw: string) => T,
  opts: { maxRepairAttempts?: number; logger?: Pick<Console, "warn"> } = {}
): Promise<{ value: T; usage: LLMUsage | null }> {
  const maxRepairAttempts = opts.maxRepairAttempts ?? 1;
  let conversation = messages;
  let lastError: ReviewValidationError | null = null;
  let usage: LLMUsage | null = null;

  for (let attempt = 0; attempt <= maxRepairAttempts; attempt++) {
    const result = await llm.completeJSON(conversation);
    usage = addUsage(usage, result.usage);
    try {
      return { value: parse(result.content), usage };
    } catch (err) {
      if (!(err instanceof ReviewValidationError)) throw err;
      lastError = err;
      opts.logger?.warn(`[review-engine] invalid model output (attempt ${attempt + 1}): ${err.message}`);
      conversation = [
        ...messages,
        { role: "assistant", content: result.content.slice(0, 8_000) },
        {
          role: "user",
          content: `Your previous answer was not valid: ${err.message}. Reply again with ONLY the JSON object in the required shape.`,
        },
      ];
    }
  }
  throw lastError!;
}

/**
 * Small wrapper used by pipeline nodes: one provider, usage summed across
 * every call in the run.
 */
export class StructuredLLM {
  usage: LLMUsage | null = null;
  calls = 0;

  constructor(readonly provider: LLMProvider, private readonly logger: Pick<Console, "warn"> = console) {}

  get model(): string {
    return this.provider.model;
  }

  async json<S extends z.ZodTypeAny>(messages: ChatMessage[], schema: S): Promise<z.infer<S>> {
    this.calls++;
    const { value, usage } = await completeStructured(this.provider, messages, (raw) => validateJSON(raw, schema), { logger: this.logger });
    this.usage = addUsage(this.usage, usage);
    return value;
  }
}
