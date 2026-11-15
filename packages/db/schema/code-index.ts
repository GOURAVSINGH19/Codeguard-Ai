import { pgTable, uuid, text, integer, timestamp, vector, index, primaryKey } from "drizzle-orm/pg-core";
import { repositories } from "./repositories";

/** Must match the embedding model (all-MiniLM-L6-v2 → 384). Changing the model = re-index. */
export const EMBEDDING_DIMENSIONS = 384;

/**
 * Pieces of a repo's code (one function/class, or a line window) with an
 * embedding: a vector that captures what the code MEANS, so we can find
 * related code even when it shares no words with the diff (RAG, Day 3.1).
 */
export const codeChunks = pgTable(
  "code_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    symbol: text("symbol"), // "verifyJwt", or null for a plain line window
    startLine: integer("start_line").notNull(),
    endLine: integer("end_line").notNull(),
    content: text("content").notNull(),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }).notNull(),
    commitSha: text("commit_sha").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("code_chunks_repo_path_idx").on(t.repositoryId, t.path),
    // HNSW: approximate nearest-neighbour search, so "closest chunks" stays fast as the table grows.
    // The operator class must match the query's distance (cosine ↔ cosineDistance).
    index("code_chunks_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
  ],
);

/**
 * One row per indexed file: its git blob sha (unchanged sha → skip re-indexing)
 * and the repo files it imports (the edges of the import graph, Day 3.2).
 */
export const codeFiles = pgTable(
  "code_files",
  {
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    blobSha: text("blob_sha").notNull(),
    imports: text("imports").array().notNull().default([]),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.repositoryId, t.path] })],
);

export type CodeChunk = typeof codeChunks.$inferSelect;
export type CodeFile = typeof codeFiles.$inferSelect;
