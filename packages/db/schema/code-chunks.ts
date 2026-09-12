import { bigint, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { vector } from "drizzle-orm/pg-core";
import { repositories } from "./repositories";

/**
 * code-chunks stores semantically chunked code fragments from repository files.
 * The `embedding` column uses pgvector (1536-dim for OpenAI ada-002 / 3072 for text-embedding-3-large).
 * Adjust the dimension to match your embedding model.
 */
export const codeChunks = pgTable(
  "code_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    filePath: text("file_path").notNull(),
    language: text("language"),
    startLine: integer("start_line").notNull(),
    endLine: integer("end_line").notNull(),
    content: text("content").notNull(),
    summary: text("summary"), // AI-generated summary of the chunk
    commitSha: text("commit_sha"),
    // pgvector column — 1536 dims (OpenAI text-embedding-3-small / ada-002)
    // Change to 3072 for text-embedding-3-large or 768 for Gemini embedding-001
    embedding: vector("embedding", { dimensions: 1536 }),
    tokenCount: integer("token_count"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // IVFFlat index for approximate nearest-neighbor search on embeddings
    index("code_chunks_embedding_idx").using("ivfflat", table.embedding.op("vector_cosine_ops")),
    index("code_chunks_repo_file_idx").on(table.repositoryId, table.filePath),
  ]
);

export type CodeChunk = typeof codeChunks.$inferSelect;
export type NewCodeChunk = typeof codeChunks.$inferInsert;
