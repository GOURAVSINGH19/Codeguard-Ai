import { z } from "zod";

export const ReviewIssueSchema = z.object({
  severity: z.enum(["critical", "high", "medium", "low"]),
  category: z.enum(["security", "bug", "performance", "maintainability", "style"]),
  line: z.number().nullable(),
  message: z.string(),
  suggestion: z.string().nullable(),
});

export const ReviewOutputSchema = z.object({
  score: z.number().min(0).max(10),
  summary: z.string(),
  issues: z.array(ReviewIssueSchema),
});

export const ReviewInputSchema = z.object({
  code: z.string().min(1, "Code snippet is required"),
  language: z.string().default("typescript"),
  title: z.string().optional(),
});

export const UuidSchema = z.string().uuid("Invalid UUID format");

export type ReviewIssue = z.infer<typeof ReviewIssueSchema>;
export type ReviewOutput = z.infer<typeof ReviewOutputSchema>;
export type ReviewInput = z.infer<typeof ReviewInputSchema>;
