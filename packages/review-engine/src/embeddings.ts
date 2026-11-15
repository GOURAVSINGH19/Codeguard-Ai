/**
 * Embeddings: text → a vector that captures meaning.
 *
 * Default: all-MiniLM-L6-v2 running LOCALLY via transformers.js (ONNX on the
 * CPU). Free, no API key, and code never leaves the worker. The model (~23 MB)
 * downloads once on first use and is cached.
 * 384 dimensions, which must match the vector(384) column in code_chunks.
 */
export interface Embedder {
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

type FeatureExtractor = (texts: string[], opts: { pooling: "mean"; normalize: boolean }) => Promise<{ tolist(): number[][] }>;

let extractor: Promise<FeatureExtractor> | undefined;

export function localEmbedder(model = "Xenova/all-MiniLM-L6-v2"): Embedder {
  return {
    model,
    dimensions: 384,
    async embed(texts) {
      if (texts.length === 0) return [];
      extractor ??= import("@huggingface/transformers").then(
        ({ pipeline }) => pipeline("feature-extraction", model, { dtype: "fp32" }) as unknown as Promise<FeatureExtractor>,
      );
      const run = await extractor;
      const out: number[][] = [];
      // Small batches keep memory flat on big repos.
      for (let i = 0; i < texts.length; i += 32) {
        const tensor = await run(texts.slice(i, i + 32), { pooling: "mean", normalize: true });
        out.push(...tensor.tolist());
      }
      return out;
    },
  };
}
