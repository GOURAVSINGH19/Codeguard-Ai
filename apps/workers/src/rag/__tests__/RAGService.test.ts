import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock @codeguard/db ───────────────────────────────────────────────────────
// vi.mock is hoisted to the top of the file by Vitest.
// IMPORTANT: The factory must use NO variables defined outside it —
// they won't be initialised yet when the factory runs.
vi.mock("@codeguard/db", () => {
  return {
    db: {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
        }),
      }),
    },
    codeChunks: {},
    repositories: {},
    // drizzle-orm re-exports used by RAGService
    eq: vi.fn(),
    sql: vi.fn((strings: TemplateStringsArray, ...values: any[]) => strings.join("?")),
  };
});

// Now safe to import — @codeguard/db is fully mocked
import { RAGService } from "../RAGService";
import type { SimilarChunk } from "../RAGService";

// ─── Mock EmbeddingService ────────────────────────────────────────────────────
const mockEmbedText = vi.fn().mockResolvedValue(new Array(1536).fill(0.1));
const mockEmbeddingService = {
  embedText: mockEmbedText,
  embedBatch: vi.fn().mockResolvedValue([new Array(1536).fill(0.1)]),
};

const ragService = new RAGService(mockEmbeddingService as any);

// ─── Get a reference to the mocked db so we can assert on it ─────────────────
// We use vi.mocked() after the mock is registered — this is safe here (not in factory).
import { db as mockedDb } from "@codeguard/db";

// ─────────────────────────────────────────────────────────────────────────────

describe("RAGService", () => {

  // ── formatContextForPrompt() — pure formatting, no I/O ───────────────────

  describe("formatContextForPrompt()", () => {
    it("returns empty string when no chunks provided", () => {
      expect(ragService.formatContextForPrompt([])).toBe("");
    });

    it("includes file path in the output", () => {
      const chunks: SimilarChunk[] = [{
        id: "1", filePath: "src/utils/auth.ts",
        startLine: 10, endLine: 30,
        content: "export function verifyToken(token: string) {}",
        language: "typescript", similarity: 0.92,
      }];
      expect(ragService.formatContextForPrompt(chunks)).toContain("src/utils/auth.ts");
    });

    it("includes start and end line numbers in the output", () => {
      const chunks: SimilarChunk[] = [{
        id: "1", filePath: "src/db/queries.ts",
        startLine: 45, endLine: 80,
        content: "export async function getUser(id: string) {}",
        language: "typescript", similarity: 0.88,
      }];
      const result = ragService.formatContextForPrompt(chunks);
      expect(result).toContain("45");
      expect(result).toContain("80");
    });

    it("includes chunk content verbatim", () => {
      const uniqueContent = "export const VERY_UNIQUE_FUNCTION_XYZ = () => {}";
      const chunks: SimilarChunk[] = [{
        id: "1", filePath: "src/index.ts",
        startLine: 1, endLine: 5,
        content: uniqueContent, language: "typescript", similarity: 0.95,
      }];
      expect(ragService.formatContextForPrompt(chunks)).toContain(uniqueContent);
    });

    it("includes all chunks when multiple are provided", () => {
      const chunks: SimilarChunk[] = [
        { id: "1", filePath: "src/a.ts", startLine: 1, endLine: 10, content: "code a", language: "typescript", similarity: 0.9 },
        { id: "2", filePath: "src/b.ts", startLine: 20, endLine: 30, content: "code b", language: "typescript", similarity: 0.85 },
        { id: "3", filePath: "src/c.ts", startLine: 5, endLine: 15, content: "code c", language: "python", similarity: 0.8 },
      ];
      const result = ragService.formatContextForPrompt(chunks);
      expect(result).toContain("src/a.ts");
      expect(result).toContain("src/b.ts");
      expect(result).toContain("src/c.ts");
    });

    it("includes the section header", () => {
      const chunks: SimilarChunk[] = [{
        id: "1", filePath: "src/x.ts",
        startLine: 1, endLine: 5,
        content: "x", language: null, similarity: 0.7,
      }];
      expect(ragService.formatContextForPrompt(chunks)).toContain("Relevant Codebase Context");
    });
  });

  // ── getSimilarChunks() — embedding service interaction ────────────────────

  describe("getSimilarChunks()", () => {
    beforeEach(() => {
      mockEmbedText.mockClear();
      vi.mocked(mockedDb.execute).mockClear();
      vi.mocked(mockedDb.execute).mockResolvedValue({ rows: [] } as any);
    });

    it("calls embedText with the exact query string", async () => {
      const query = "function to check authentication";
      await ragService.getSimilarChunks(query, "repo-uuid-123", 3);
      expect(mockEmbedText).toHaveBeenCalledWith(query);
    });

    it("calls embedText exactly once per query", async () => {
      await ragService.getSimilarChunks("some query", "repo-uuid-123", 5);
      expect(mockEmbedText).toHaveBeenCalledTimes(1);
    });

    it("returns empty array when db returns no rows", async () => {
      const result = await ragService.getSimilarChunks("query", "repo-uuid-123", 5);
      expect(result).toEqual([]);
    });

    it("calls db.execute to perform the similarity search", async () => {
      await ragService.getSimilarChunks("query", "specific-repo-id", 5);
      expect(mockedDb.execute).toHaveBeenCalledTimes(1);
    });
  });
});
