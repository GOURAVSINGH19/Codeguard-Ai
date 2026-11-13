import { z } from "zod";

export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export const CATEGORIES = ["security", "bug", "performance", "maintainability", "style"] as const;
export type Severity = (typeof SEVERITIES)[number];
export type Category = (typeof CATEGORIES)[number];

/**
 * The contract with the model. JSON mode only guarantees *valid JSON*;
 * this checks the *meaning*: required fields, ranges and allowed values.
 * coerce: models sometimes send "42" instead of 42.
 */
export const ModelFinding = z.object({
  file: z.string().min(1),
  line: z.coerce.number().int().positive(),
  severity: z.enum(SEVERITIES),
  category: z.enum(CATEGORIES),
  message: z.string().min(5).max(1000),
  suggestion: z.string().max(2000).nullish().transform((s) => s ?? null),
});

export const ModelReview = z.object({
  summary: z.string().min(1).max(2000),
  score: z.coerce.number().int().min(0).max(100),
  findings: z.array(ModelFinding).max(40),
});

export type ModelFinding = z.infer<typeof ModelFinding>;
export type ModelReview = z.infer<typeof ModelReview>;

/** A finding after our own checks, ready to store and publish. */
export interface Finding {
  file: string | null;
  line: number | null;
  severity: Severity;
  category: Category;
  message: string;
  suggestion: string | null;
  source: "ai" | "eslint";
  /** true when GitHub will accept an inline comment on this line. */
  inline: boolean;
}
