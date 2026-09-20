import { describe, it, expect } from "vitest";
import {
  ReviewOutputSchema,
  ReviewInputSchema,
  ReviewIssueSchema,
  UuidSchema,
} from "../review";

// ─────────────────────────────────────────────────────────────────────────────
// ReviewOutputSchema — validates AI response before it touches the DB
// ─────────────────────────────────────────────────────────────────────────────
describe("ReviewOutputSchema", () => {
  const validOutput = {
    score: 7.5,
    summary: "The code has a few issues.",
    issues: [
      {
        severity: "high",
        category: "security",
        line: 12,
        message: "SQL injection risk",
        suggestion: "Use parameterized queries",
      },
    ],
  };

  it("accepts a valid review output", () => {
    const result = ReviewOutputSchema.safeParse(validOutput);
    expect(result.success).toBe(true);
  });

  it("accepts score of exactly 0", () => {
    const result = ReviewOutputSchema.safeParse({ ...validOutput, score: 0 });
    expect(result.success).toBe(true);
  });

  it("accepts score of exactly 10", () => {
    const result = ReviewOutputSchema.safeParse({ ...validOutput, score: 10 });
    expect(result.success).toBe(true);
  });

  it("rejects score above 10", () => {
    const result = ReviewOutputSchema.safeParse({ ...validOutput, score: 10.1 });
    expect(result.success).toBe(false);
  });

  it("rejects score below 0", () => {
    const result = ReviewOutputSchema.safeParse({ ...validOutput, score: -0.1 });
    expect(result.success).toBe(false);
  });

  it("rejects missing summary", () => {
    const { summary: _, ...noSummary } = validOutput;
    const result = ReviewOutputSchema.safeParse(noSummary);
    expect(result.success).toBe(false);
  });

  it("rejects missing issues array", () => {
    const { issues: _, ...noIssues } = validOutput;
    const result = ReviewOutputSchema.safeParse(noIssues);
    expect(result.success).toBe(false);
  });

  it("accepts empty issues array (clean code)", () => {
    const result = ReviewOutputSchema.safeParse({ ...validOutput, issues: [] });
    expect(result.success).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ReviewIssueSchema — severity + category enum enforcement
// ─────────────────────────────────────────────────────────────────────────────
describe("ReviewIssueSchema", () => {
  const validIssue = {
    severity: "critical",
    category: "security",
    line: null,
    message: "Hardcoded secret detected",
    suggestion: "Move to environment variable",
  };

  it("accepts all valid severity values", () => {
    const severities = ["critical", "high", "medium", "low"];
    for (const severity of severities) {
      const result = ReviewIssueSchema.safeParse({ ...validIssue, severity });
      expect(result.success, `severity '${severity}' should be valid`).toBe(true);
    }
  });

  it("rejects invalid severity value", () => {
    const result = ReviewIssueSchema.safeParse({ ...validIssue, severity: "warning" });
    expect(result.success).toBe(false);
  });

  it("accepts all valid category values", () => {
    const categories = ["security", "bug", "performance", "maintainability", "style"];
    for (const category of categories) {
      const result = ReviewIssueSchema.safeParse({ ...validIssue, category });
      expect(result.success, `category '${category}' should be valid`).toBe(true);
    }
  });

  it("rejects invalid category value", () => {
    const result = ReviewIssueSchema.safeParse({ ...validIssue, category: "other" });
    expect(result.success).toBe(false);
  });

  it("accepts line: null", () => {
    const result = ReviewIssueSchema.safeParse({ ...validIssue, line: null });
    expect(result.success).toBe(true);
  });

  it("accepts a specific line number", () => {
    const result = ReviewIssueSchema.safeParse({ ...validIssue, line: 42 });
    expect(result.success).toBe(true);
  });

  it("accepts null suggestion", () => {
    const result = ReviewIssueSchema.safeParse({ ...validIssue, suggestion: null });
    expect(result.success).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ReviewInputSchema
// ─────────────────────────────────────────────────────────────────────────────
describe("ReviewInputSchema", () => {
  it("accepts valid code input", () => {
    const result = ReviewInputSchema.safeParse({
      code: "const x = 1;",
      language: "typescript",
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty code string", () => {
    const result = ReviewInputSchema.safeParse({ code: "", language: "typescript" });
    expect(result.success).toBe(false);
  });

  it("defaults language to typescript when not provided", () => {
    const result = ReviewInputSchema.safeParse({ code: "const x = 1;" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.language).toBe("typescript");
    }
  });

  it("accepts optional title", () => {
    const result = ReviewInputSchema.safeParse({
      code: "const x = 1;",
      language: "javascript",
      title: "My Review",
    });
    expect(result.success).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// UuidSchema
// ─────────────────────────────────────────────────────────────────────────────
describe("UuidSchema", () => {
  it("accepts a valid UUID v4", () => {
    const result = UuidSchema.safeParse("550e8400-e29b-41d4-a716-446655440000");
    expect(result.success).toBe(true);
  });

  it("rejects a plain string", () => {
    const result = UuidSchema.safeParse("not-a-uuid");
    expect(result.success).toBe(false);
  });

  it("rejects empty string", () => {
    const result = UuidSchema.safeParse("");
    expect(result.success).toBe(false);
  });

  it("rejects a numeric ID", () => {
    const result = UuidSchema.safeParse("12345");
    expect(result.success).toBe(false);
  });
});
