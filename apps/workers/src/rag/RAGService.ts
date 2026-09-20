import { db, codeChunks, repositories } from "@codeguard/db";
import { eq, sql } from "drizzle-orm";
import { EmbeddingService } from "../ai/EmbeddingService.js";
import { CodeChunker } from "../analyzers/CodeChunker.js";
import { Octokit } from "octokit";

export interface SimilarChunk {
  id: string;
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
  language: string | null;
  similarity: number;
}

export interface IndexingResult {
  repositoryId: string;
  filesIndexed: number;
  chunksCreated: number;
  skippedFiles: number;
}

// File extensions worth indexing — skip binary, lock files, generated code
const INDEXABLE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".java", ".kt", ".swift",
  ".c", ".cpp", ".h", ".hpp", ".cs",
  ".rb", ".php", ".vue", ".svelte",
  ".sql", ".graphql", ".gql",
  ".sh", ".bash", ".zsh",
  ".yaml", ".yml", ".json", ".toml", ".env.example",
  ".md", ".mdx",
]);

// Never index these paths
const SKIP_PATTERNS = [
  "node_modules", ".git", "dist", "build", ".next", ".nuxt",
  "coverage", "__pycache__", ".venv", "vendor",
  "pnpm-lock.yaml", "yarn.lock", "package-lock.json",
  ".min.js", ".min.css", ".map",
];

/**
 * RAGService
 *
 * Two responsibilities:
 *  1. INDEX  — fetch all files in a repo via GitHub API, chunk + embed them,
 *              store in the code_chunks table with pgvector embeddings
 *  2. QUERY  — given a query string (e.g. a PR diff), find the most
 *              semantically similar chunks using cosine similarity search
 *
 * The query results are injected into the AI review prompt so the LLM
 * has codebase context beyond just the PR diff.
 */
export class RAGService {
  private readonly embeddingService: EmbeddingService;
  private readonly chunker: CodeChunker;

  constructor(embeddingService: EmbeddingService) {
    this.embeddingService = embeddingService;
    this.chunker = new CodeChunker();
  }

  // ─── Indexing ─────────────────────────────────────────────────────────────

  /**
   * Index all source files in a GitHub repository.
   * Fetches the file tree via GitHub API, chunks each file, embeds + stores.
   *
   * Designed for the Kafka indexRepository job — called once when a new
   * repository is added, then incrementally on push events.
   */
  async indexRepository(
    repositoryId: string,
    owner: string,
    repo: string,
    octokit: Octokit,
    defaultBranch: string = "main"
  ): Promise<IndexingResult> {
    console.log(`[RAGService] Starting index for ${owner}/${repo}`);

    // Fetch the full file tree (recursive = flat list of all files)
    const { data: treeData } = await octokit.rest.git.getTree({
      owner,
      repo,
      tree_sha: defaultBranch,
      recursive: "1",
    });

    const indexableFiles = (treeData.tree ?? []).filter(
      (item) =>
        item.type === "blob" &&
        item.path &&
        this.shouldIndex(item.path)
    );

    console.log(
      `[RAGService] Found ${indexableFiles.length} indexable files in ${owner}/${repo}`
    );

    let filesIndexed = 0;
    let chunksCreated = 0;
    let skippedFiles = 0;

    // Process files in small batches to avoid GitHub API rate limits
    const BATCH = 10;
    for (let i = 0; i < indexableFiles.length; i += BATCH) {
      const batch = indexableFiles.slice(i, i + BATCH);

      await Promise.all(
        batch.map(async (file) => {
          try {
            const created = await this.indexFile(
              repositoryId,
              owner,
              repo,
              file.path!,
              file.sha!,
              octokit
            );
            if (created > 0) {
              filesIndexed++;
              chunksCreated += created;
            } else {
              skippedFiles++;
            }
          } catch (err: any) {
            console.warn(
              `[RAGService] Skipped ${file.path}: ${err.message}`
            );
            skippedFiles++;
          }
        })
      );
    }

    console.log(
      `[RAGService] Indexed ${filesIndexed} files, ${chunksCreated} chunks, skipped ${skippedFiles}`
    );

    return { repositoryId, filesIndexed, chunksCreated, skippedFiles };
  }

  /**
   * Fetch, chunk, embed, and store a single file.
   * Returns the number of chunks created (0 = skipped).
   * Public for incremental re-indexing on push events.
   */
  async indexFile(
    repositoryId: string,
    owner: string,
    repo: string,
    filePath: string,
    fileSha: string,
    octokit: Octokit
  ): Promise<number> {
    // Fetch file content from GitHub (base64 encoded)
    const { data } = await octokit.rest.git.getBlob({
      owner,
      repo,
      file_sha: fileSha,
    });

    // Skip files > 200KB — too large to be useful for RAG
    if ((data.size ?? 0) > 200_000) return 0;

    const content = Buffer.from(data.content, "base64").toString("utf-8");

    // Skip binary-looking files
    if (this.isBinary(content)) return 0;

    const language = this.detectLanguage(filePath);

    // Use AST chunking for supported languages, fallback to line-based
    const strategy = language && CodeChunker.isSupported(language) ? "ast" : "lines";
    const chunks = await this.chunker.chunk(content, strategy, language ?? undefined);
    if (chunks.length === 0) return 0;

    // Delete existing chunks for this file (re-indexing on push)
    await db
      .delete(codeChunks)
      .where(
        sql`${codeChunks.repositoryId} = ${repositoryId} AND ${codeChunks.filePath} = ${filePath}`
      );

    // Embed all chunks in one batched API call
    const embeddings = await this.embeddingService.embedBatch(
      chunks.map((c) => `// File: ${filePath}\n${c.content}`)
    );

    // Batch insert all chunks
    await db.insert(codeChunks).values(
      chunks.map((chunk, idx) => ({
        repositoryId,
        filePath,
        language,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        content: chunk.content,
        commitSha: fileSha,
        embedding: embeddings[idx],
        tokenCount: this.chunker.estimateTokens(chunk.content),
      }))
    );

    return chunks.length;
  }

  // ─── Querying ─────────────────────────────────────────────────────────────

  /**
   * Find the most semantically similar code chunks for a given query.
   *
   * Uses pgvector cosine distance operator (<=>).
   * Lower distance = higher similarity.
   *
   * @param query         Natural language or code query (e.g. PR diff excerpt)
   * @param repositoryId  Scopes results to one repository
   * @param limit         Max chunks to return (default 5)
   */
  async getSimilarChunks(
    query: string,
    repositoryId: string,
    limit = 5
  ): Promise<SimilarChunk[]> {
    const queryEmbedding = await this.embeddingService.embedText(query);

    // Format embedding as pgvector literal: '[0.1, 0.2, ...]'
    const vectorLiteral = `[${queryEmbedding.join(",")}]`;

    const results = await db.execute(sql`
      SELECT
        id,
        file_path        AS "filePath",
        start_line       AS "startLine",
        end_line         AS "endLine",
        content,
        language,
        1 - (embedding <=> ${vectorLiteral}::vector) AS similarity
      FROM code_chunks
      WHERE repository_id = ${repositoryId}
        AND embedding IS NOT NULL
      ORDER BY embedding <=> ${vectorLiteral}::vector
      LIMIT ${limit}
    `);

    return (results.rows as any[]).map((row) => ({
      id: row.id,
      filePath: row.filePath,
      startLine: Number(row.startLine),
      endLine: Number(row.endLine),
      content: row.content,
      language: row.language,
      similarity: Number(row.similarity),
    }));
  }

  /**
   * Format similar chunks into a prompt-friendly context block.
   * Injected into the AI review prompt before the diff.
   */
  formatContextForPrompt(chunks: SimilarChunk[]): string {
    if (chunks.length === 0) return "";

    const sections = chunks.map(
      (c) =>
        `### ${c.filePath} (lines ${c.startLine}–${c.endLine})\n` +
        "```\n" +
        c.content +
        "\n```"
    );

    return (
      "## Relevant Codebase Context\n" +
      "The following code from this repository is semantically related to the PR changes:\n\n" +
      sections.join("\n\n")
    );
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private shouldIndex(filePath: string): boolean {
    // Skip known noisy paths
    if (SKIP_PATTERNS.some((p) => filePath.includes(p))) return false;

    // Check extension
    const ext = filePath.slice(filePath.lastIndexOf("."));
    return INDEXABLE_EXTENSIONS.has(ext);
  }

  private detectLanguage(filePath: string): string | null {
    const ext = filePath.slice(filePath.lastIndexOf("."));
    const map: Record<string, string> = {
      ".ts": "typescript", ".tsx": "typescript",
      ".js": "javascript", ".jsx": "javascript",
      ".mjs": "javascript", ".cjs": "javascript",
      ".py": "python", ".go": "go", ".rs": "rust",
      ".java": "java", ".kt": "kotlin", ".swift": "swift",
      ".c": "c", ".cpp": "cpp", ".h": "c", ".hpp": "cpp",
      ".cs": "csharp", ".rb": "ruby", ".php": "php",
      ".vue": "vue", ".svelte": "svelte",
      ".sql": "sql", ".graphql": "graphql", ".gql": "graphql",
      ".sh": "bash", ".bash": "bash", ".zsh": "bash",
      ".yaml": "yaml", ".yml": "yaml",
      ".json": "json", ".toml": "toml",
      ".md": "markdown", ".mdx": "markdown",
    };
    return map[ext] ?? null;
  }

  private isBinary(content: string): boolean {
    // Heuristic: if >10% of chars are non-printable, treat as binary
    let nonPrintable = 0;
    const sample = content.slice(0, 1000);
    for (const char of sample) {
      const code = char.charCodeAt(0);
      if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
        nonPrintable++;
      }
    }
    return nonPrintable / sample.length > 0.1;
  }
}
