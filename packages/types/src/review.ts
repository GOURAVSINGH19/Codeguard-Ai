import { z } from "zod";

export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export const CATEGORIES = [
  "security",
  "bug",
  "performance",
  "maintainability",
  "style",
] as const;

/**
 * LLMs sometimes return 0, "12" or 12.0 for a line. Coerce anything that is not
 * a usable 1-indexed line into `null` instead of failing the whole review.
 */
function normalizeLine(value: unknown): number | null {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : null;
}

export const ReviewIssueSchema = z.object({
  severity: z.enum(SEVERITIES),
  category: z.enum(CATEGORIES),
  /**
   * Path of the file the issue belongs to (PR reviews). `null` for snippet
   * reviews or when the model could not attribute the issue to a file.
   */
  file: z.string().nullable().default(null),
  /** 1-indexed line number in the NEW version of the file (right side of the diff). */
  line: z.preprocess(normalizeLine, z.number().int().positive().nullable()),
  message: z.string().min(1),
  suggestion: z.string().nullable(),
});

export const ReviewOutputSchema = z.object({
  score: z.number().min(0).max(10),
  summary: z.string(),
  issues: z.array(ReviewIssueSchema),
});

export const ReviewInputSchema = z.object({
  code: z.string().min(1, "Code snippet is required").max(50_000, "Code snippet is too large (max 50,000 characters)"),
  language: z.string().max(40).default("typescript"),
  title: z.string().max(200).optional(),
});

export const PRReviewRequestSchema = z.object({
  owner: z.string().min(1).max(100),
  repo: z.string().min(1).max(100),
  pullNumber: z.coerce.number().int().positive(),
});

export const UuidSchema = z.string().uuid("Invalid UUID format");

export type ReviewIssue = z.infer<typeof ReviewIssueSchema>;
export type ReviewOutput = z.infer<typeof ReviewOutputSchema>;
export type ReviewInput = z.infer<typeof ReviewInputSchema>;
export type PRReviewRequest = z.infer<typeof PRReviewRequestSchema>;
