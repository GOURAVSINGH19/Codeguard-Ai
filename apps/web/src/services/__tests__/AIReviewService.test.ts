import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AIReviewService } from "../AIReviewService";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const VALID_AI_RESPONSE = {
  score: 7.5,
  summary: "Code has a SQL injection vulnerability.",
  issues: [
    {
      severity: "critical",
      category: "security",
      line: 5,
      message: "SQL injection risk via string interpolation",
      suggestion: "Use parameterized queries: db.query('SELECT * FROM users WHERE id = $1', [id])",
    },
  ],
};

function mockFetchSuccess(payload: object) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify(payload) } }],
    }),
    text: async () => "",
  });
}

function mockFetchHttpError(status: number, body: string) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    text: async () => body,
    json: async () => ({}),
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("AIReviewService", () => {
  const service = new AIReviewService("test-api-key", "test-model");

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── fromEnv() factory ─────────────────────────────────────────────────────

  describe("fromEnv()", () => {
    it("throws when GROQ_API_KEY is not set", () => {
      const original = process.env.GROQ_API_KEY;
      delete process.env.GROQ_API_KEY;
      delete process.env.OPENAI_API_KEY;

      expect(() => AIReviewService.fromEnv()).toThrow(
        "AI service configuration missing"
      );

      process.env.GROQ_API_KEY = original;
    });

    it("creates an instance when GROQ_API_KEY is set", () => {
      process.env.GROQ_API_KEY = "test-key";
      process.env.GROQ_MODEL = "test-model";

      const instance = AIReviewService.fromEnv();
      expect(instance).toBeInstanceOf(AIReviewService);

      delete process.env.GROQ_API_KEY;
    });
  });

  // ── reviewSnippet() ───────────────────────────────────────────────────────

  describe("reviewSnippet()", () => {
    it("returns parsed ReviewOutput on successful AI response", async () => {
      vi.stubGlobal("fetch", mockFetchSuccess(VALID_AI_RESPONSE));

      const result = await service.reviewSnippet("const x = 1;", "typescript");

      expect(result.score).toBe(7.5);
      expect(result.summary).toBe("Code has a SQL injection vulnerability.");
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].severity).toBe("critical");
    });

    it("throws when Groq returns HTTP error", async () => {
      vi.stubGlobal("fetch", mockFetchHttpError(429, "rate limited"));

      await expect(
        service.reviewSnippet("const x = 1;", "typescript")
      ).rejects.toThrow("Groq API error (429)");
    });

    it("throws when AI response content is empty", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ choices: [{ message: { content: "" } }] }),
        })
      );

      await expect(
        service.reviewSnippet("const x = 1;", "typescript")
      ).rejects.toThrow("empty response");
    });

    it("throws when AI returns invalid JSON", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            choices: [{ message: { content: "not valid json {{{{" } }],
          }),
        })
      );

      await expect(
        service.reviewSnippet("const x = 1;", "typescript")
      ).rejects.toThrow("invalid JSON");
    });

    it("throws ZodError when AI returns invalid schema (score > 10)", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetchSuccess({ ...VALID_AI_RESPONSE, score: 99 })
      );

      await expect(
        service.reviewSnippet("const x = 1;", "typescript")
      ).rejects.toThrow();
    });

    it("throws ZodError when AI returns invalid severity enum", async () => {
      const badPayload = {
        ...VALID_AI_RESPONSE,
        issues: [{ ...VALID_AI_RESPONSE.issues[0], severity: "catastrophic" }],
      };
      vi.stubGlobal("fetch", mockFetchSuccess(badPayload));

      await expect(
        service.reviewSnippet("const x = 1;", "typescript")
      ).rejects.toThrow();
    });
  });

  // ── reviewPRDiff() diff truncation ────────────────────────────────────────

  describe("reviewPRDiff() — diff truncation", () => {
    it("truncates diffContext to 12,000 chars before sending to Groq", async () => {
      let capturedBody = "";
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation(async (_url: string, opts: RequestInit) => {
          capturedBody = opts.body as string;
          return {
            ok: true,
            json: async () => ({
              choices: [{ message: { content: JSON.stringify(VALID_AI_RESPONSE) } }],
            }),
          };
        })
      );

      const hugeDiff = "x".repeat(20_000);
      await service.reviewPRDiff(hugeDiff, "Add feature", null);

      const parsed = JSON.parse(capturedBody);
      const userContent: string = parsed.messages[1].content;

      // The diff in the prompt should never exceed 12,000 chars
      expect(userContent.length).toBeLessThanOrEqual(12_100); // small buffer for the label
    });

    it("does not truncate diff under 12,000 chars", async () => {
      let capturedBody = "";
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation(async (_url: string, opts: RequestInit) => {
          capturedBody = opts.body as string;
          return {
            ok: true,
            json: async () => ({
              choices: [{ message: { content: JSON.stringify(VALID_AI_RESPONSE) } }],
            }),
          };
        })
      );

      const shortDiff = "const x = 1;\n".repeat(100); // ~1,400 chars
      await service.reviewPRDiff(shortDiff, "Small fix", null);

      const parsed = JSON.parse(capturedBody);
      const userContent: string = parsed.messages[1].content;

      expect(userContent).toContain(shortDiff);
    });
  });
});
