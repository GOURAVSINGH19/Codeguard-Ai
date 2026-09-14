import OpenAI from "openai";

// Must match the vector dimension in packages/db/schema/code-chunks.ts
const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIMENSIONS = 1536;
// OpenAI allows up to 2048 items per batch call
const BATCH_SIZE = 100;

/**
 * EmbeddingService
 *
 * Wraps OpenAI's text-embedding-3-small model.
 * Produces 1536-dimensional vectors that map directly into the
 * pgvector `embedding` column on the `code_chunks` table.
 *
 * Why text-embedding-3-small?
 *  - 1536 dims matches the schema (no migration needed)
 *  - ~5x cheaper than ada-002 with better benchmark scores
 *  - Fast enough for bulk repository indexing
 */
export class EmbeddingService {
  private readonly client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  static fromEnv(): EmbeddingService {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "OPENAI_API_KEY is required for RAG embeddings. " +
          "Set it in apps/workers/.env"
      );
    }
    return new EmbeddingService(apiKey);
  }

  /**
   * Embed a single text string.
   * Returns a 1536-dimensional float array.
   */
  async embedText(text: string): Promise<number[]> {
    const response = await this.client.embeddings.create({
      model: EMBEDDING_MODEL,
      input: this.truncate(text),
      dimensions: EMBEDDING_DIMENSIONS,
    });
    return response.data[0].embedding;
  }

  /**
   * Embed multiple texts in batches of BATCH_SIZE.
   * More efficient than individual calls for bulk indexing.
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE).map((t) => this.truncate(t));

      const response = await this.client.embeddings.create({
        model: EMBEDDING_MODEL,
        input: batch,
        dimensions: EMBEDDING_DIMENSIONS,
      });

      // OpenAI returns embeddings in the same order as input
      const batchEmbeddings = response.data
        .sort((a, b) => a.index - b.index)
        .map((d) => d.embedding);

      results.push(...batchEmbeddings);
    }

    return results;
  }

  /**
   * OpenAI limits input to ~8192 tokens (~32k chars).
   * Truncate to be safe without calling a tokenizer.
   */
  private truncate(text: string): string {
    return text.slice(0, 8000);
  }
}
