import { describe, it, expect } from "vitest";
import { CodeChunker } from "../CodeChunker";

const chunker = new CodeChunker();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeLines(n: number): string {
  return Array.from({ length: n }, (_, i) => `const line${i + 1} = ${i + 1};`).join(
    "\n"
  );
}

// ─────────────────────────────────────────────────────────────────────────────

describe("CodeChunker", () => {

  describe("chunk()", () => {
    it("returns a single chunk for a file under CHUNK_SIZE lines", async () => {
      const content = makeLines(30);
      const chunks = await chunker.chunk(content);

      expect(chunks).toHaveLength(1);
      expect(chunks[0].startLine).toBe(1);
      expect(chunks[0].endLine).toBe(30);
    });

    it("returns multiple chunks for a file over CHUNK_SIZE lines", async () => {
      const content = makeLines(200);
      const chunks = await chunker.chunk(content);

      expect(chunks.length).toBeGreaterThan(1);
    });

    it("first chunk always starts at line 1", async () => {
      const content = makeLines(150);
      const chunks = await chunker.chunk(content);

      expect(chunks[0].startLine).toBe(1);
    });

    it("last chunk endLine is <= total line count", async () => {
      const lineCount = 150;
      const content = makeLines(lineCount);
      const chunks = await chunker.chunk(content);
      const lastChunk = chunks[chunks.length - 1];

      expect(lastChunk.endLine).toBeLessThanOrEqual(lineCount);
    });

    it("chunks have overlapping line ranges (sliding window)", async () => {
      const content = makeLines(200);
      const chunks = await chunker.chunk(content);

      // Each subsequent chunk's startLine should be LESS than previous endLine
      for (let i = 1; i < chunks.length; i++) {
        expect(chunks[i].startLine).toBeLessThan(chunks[i - 1].endLine);
      }
    });

    it("skips chunks with fewer than 3 non-empty lines", async () => {
      // Only 2 real lines + lots of blanks
      const content = "const a = 1;\n\n\n\n\n\n\nconst b = 2;";
      const chunks = await chunker.chunk(content);

      // This should be skipped (< 3 non-empty lines)
      expect(chunks).toHaveLength(0);
    });

    it("each chunk's content matches the line range", async () => {
      const content = makeLines(100);
      const lines = content.split("\n");
      const chunks = await chunker.chunk(content);

      for (const chunk of chunks) {
        const expectedContent = lines
          .slice(chunk.startLine - 1, chunk.endLine)
          .join("\n");
        expect(chunk.content).toBe(expectedContent);
      }
    });

    it("returns empty array for empty file", async () => {
      const chunks = await chunker.chunk("");
      expect(chunks).toHaveLength(0);
    });

    it("returns empty array for whitespace-only file", async () => {
      const chunks = await chunker.chunk("   \n\n   \n\n");
      expect(chunks).toHaveLength(0);
    });
  });

  // ── estimateTokens() ──────────────────────────────────────────────────────

  describe("estimateTokens()", () => {
    it("estimates ~1 token per 4 chars", () => {
      const content = "a".repeat(400); // 400 chars → ~100 tokens
      const tokens = chunker.estimateTokens(content);
      expect(tokens).toBe(100);
    });

    it("rounds up fractional tokens", () => {
      const content = "a".repeat(401); // 401 chars → ceil(401/4) = 101 tokens
      const tokens = chunker.estimateTokens(content);
      expect(tokens).toBe(101);
    });

    it("returns 0 for empty string", () => {
      expect(chunker.estimateTokens("")).toBe(0);
    });
  });
});
