export interface CodeChunkResult {
  content: string;
  startLine: number; // 1-indexed
  endLine: number;   // 1-indexed, inclusive
  nodeType?: string; // "function" | "class" | "method" | etc. (AST mode)
  name?: string;     // function/class name (AST mode)
}

export type ChunkingStrategy = "lines" | "ast";

// How many lines per chunk (line-based strategy)
const CHUNK_SIZE = 80;
// How many lines overlap between adjacent chunks (preserves context at boundaries)
const OVERLAP = 15;

/**
 * CodeChunker
 *
 * Splits a source file into chunks ready for embedding.
 * Supports two strategies:
 * - "lines": Line-based sliding window (default, language-agnostic)
 * - "ast":   AST-aware semantic chunking (function/class boundaries)
 *
 * Design decisions:
 * - Line-based: 80-line chunks with 15-line overlap keeps each chunk under ~2k tokens
 *   (safe for text-embedding-3-small's 8192 token limit)
 * - AST-based: Extracts functions, classes, methods as semantic units
 *   Preserves code structure and context at boundaries
 */
export class CodeChunker {
  private astChunker: any = null; // Lazy-loaded to avoid tree-sitter init overhead

  /**
   * Chunk a file's content using the specified strategy.
   *
   * @param content    Full file content as a string
   * @param strategy   "lines" (default) or "ast"
   * @param language   Language identifier (required for "ast" strategy)
   * @returns          Array of chunk objects with content + line ranges
   */
  async chunk(
    content: string,
    strategy: ChunkingStrategy = "lines",
    language?: string
  ): Promise<CodeChunkResult[]> {
    if (strategy === "ast" && language) {
      return this.chunkWithAST(content, language);
    }
    return this.chunkWithLines(content);
  }

  /**
   * Line-based chunking (original implementation).
   */
  private chunkWithLines(content: string): CodeChunkResult[] {
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
          startLine: start + 1,
          endLine: end,
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
   * AST-based semantic chunking using tree-sitter.
   * Falls back to line-based if AST parsing fails or language unsupported.
   */
  private async chunkWithAST(
    content: string,
    language: string
  ): Promise<CodeChunkResult[]> {
    try {
      if (!this.astChunker) {
        const { astChunker } = await import("./ASTChunker.js");
        this.astChunker = astChunker;
        await this.astChunker.initialize();
      }

      if (!this.astChunker.isSupported(language)) {
        console.log(`[CodeChunker] AST not supported for ${language}, falling back to line-based`);
        return this.chunkWithLines(content);
      }

      const astChunks = await this.astChunker.chunk(content, language);

      if (astChunks.length === 0) {
        console.log(`[CodeChunker] AST produced no chunks for ${language}, falling back`);
        return this.chunkWithLines(content);
      }

      // Convert AST chunks to our format
      return astChunks.map((c: any) => ({
        content: c.content,
        startLine: c.startLine,
        endLine: c.endLine,
        nodeType: c.nodeType,
        name: c.name,
      }));
    } catch (err) {
      console.warn("[CodeChunker] AST chunking failed, falling back to line-based:", err);
      return this.chunkWithLines(content);
    }
  }

  /**
   * Estimate token count using a rough 1 token ≈ 4 chars heuristic.
   * Good enough to detect chunks that might exceed model limits.
   */
  estimateTokens(content: string): number {
    return Math.ceil(content.length / 4);
  }

  /**
   * Check if AST chunking is supported for a language.
   * Uses the ASTChunker's language support detection.
   */
  static isSupported(language: string): boolean {
    const supportedLanguages = [
      "typescript", "javascript", "python", "go", "rust", "java", "cpp",
      "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "rs", "java", "cpp", "hpp", "h"
    ];
    return supportedLanguages.includes(language.toLowerCase());
  }
}
