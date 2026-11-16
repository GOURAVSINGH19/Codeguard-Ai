/**
 * The only thing the pipeline knows about a model.
 * Groq, OpenAI, or anything else plugs in behind this interface, so swapping
 * models never touches pipeline code.
 */
export interface LLMRequest {
  system: string;
  /** The conversation after the system prompt; usually one user message. */
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  /** Ask for a JSON object (provider "JSON mode"). Still validate with Zod! */
  json?: boolean;
  temperature?: number;
  maxTokens?: number;
}

export interface LLMResponse {
  text: string;
  tokens: number;
}

export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  complete(req: LLMRequest): Promise<LLMResponse>;
}

export class LLMError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "LLMError";
  }
}
