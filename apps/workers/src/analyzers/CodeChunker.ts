export interface CodeChunkResult {
  content: string;
  startLine: number; // 1-indexed
  endLine: number;   // 1-indexed, inclusive
}

// How many lines per chunk
const CHUNK_SIZE = 80;
// How many lines overlap between adjacent chunks (preserves context at boundaries)
const OVERLAP = 15;

/**
 * CodeChunker
 *
 * Splits a source file into overlapping fixed-size chunks ready for embedding.
 *
 * Design decisions:
 * - Line-based sliding window — simple, language-agnostic, no AST required
 * - 80-line chunks with 15-line overlap keeps each chunk under ~2k tokens
 *   (safe for text-embedding-3-small's 8192 token limit)
 * - Overlap prevents losing context at chunk boundaries (e.g. a function
 *   signature on line 79 that the body starts on line 81 is captured in both)
 * - Skips chunks that are pure whitespace / comments (low signal for RAG)
 *
 * A future improvement would be AST-aware chunking (split on function/class
 * boundaries), but line-based works well enough for portfolio purposes.
 */
export class CodeChunker {
  /**
   * Chunk a file's content into overlapping segments.
   *
   * @param content  Full file content as a string
   * @returns        Array of chunk objects with content + line ranges
   */
  chunk(content: string): CodeChunkResult[] {
    const lines = content.split("\n");
    const chunks: CodeChunkResult[] = [];

    let start = 0; // 0-indexed into lines array

    while (start < lines.length) {
      const end = Math.min(start + CHUNK_SIZE, lines.length);
      const chunkLines = lines.slice(start, end);
      const chunkContent = chunkLines.join("\n");

      // Skip chunks that are almost entirely blank (< 3 non-empty lines)
      const nonEmpty = chunkLines.filter((l) => l.trim().length > 0).length;
      if (nonEmpty >= 3) {
        chunks.push({
          content: chunkContent,
          startLine: start + 1,       // convert to 1-indexed
          endLine: end,               // end is exclusive in slice, so this is 1-indexed inclusive
        });
      }

      // Advance by CHUNK_SIZE - OVERLAP to create the sliding window
      start += CHUNK_SIZE - OVERLAP;

      // Don't create a tiny leftover chunk at the end
      if (start < lines.length && lines.length - start < OVERLAP) break;
    }

    return chunks;
  }

  /**
   * Estimate token count using a rough 1 token ≈ 4 chars heuristic.
   * Good enough to detect chunks that might exceed model limits.
   */
  estimateTokens(content: string): number {
    return Math.ceil(content.length / 4);
  }
}
