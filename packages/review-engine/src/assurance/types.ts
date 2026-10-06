import { createHash } from "node:crypto";
import type { ReviewIssue } from "@codeguard/types";

/**
 * Shared vocabulary of the staged review ("assurance") pipeline.
 *
 *   Stage 1 understand the change: committer · align · volume · cohesion
 *   Stage 2 understand the risk:   blast_radius · criticality
 *   Stage 3 validate the change:   quality · security · testing
 *
 * Every analyzer returns `Finding`s — a `ReviewIssue` plus where it came from
 * and how sure we are — so aggregation, dedupe, verification and policy can
 * treat deterministic rules and LLM output the same way.
 */

export const FINDING_SOURCES = [
  "committer",
  "align",
  "volume",
  "cohesion",
  "blast_radius",
  "criticality",
  "quality",
  "security",
  "testing",
] as const;
export type FindingSource = (typeof FINDING_SOURCES)[number];

export interface Finding extends ReviewIssue {
  /** Stable id: same source + location + message → same id across runs. */
  id: string;
  source: FindingSource;
  /** 0..1 — how likely the finding is real. */
  confidence: number;
  /** Rule id for deterministic findings, e.g. "secret/aws-access-key". */
  ruleId: string | null;
  /** True when produced by code, not a model. */
  deterministic: boolean;
  /** Other sources that reported the same problem (set by dedupe). */
  alsoReportedBy?: FindingSource[];
  /** Set by independent verification. */
  verification?: "confirmed" | "uncertain" | "trusted" | "unverified";
}

export function findingId(source: string, file: string | null, line: number | null, key: string): string {
  return createHash("sha1").update(`${source}|${file ?? ""}|${line ?? ""}|${key}`).digest("hex").slice(0, 16);
}

export function makeFinding(input: Omit<Finding, "id" | "suggestion" | "file" | "line" | "ruleId"> & Partial<Pick<Finding, "suggestion" | "file" | "line" | "ruleId">>): Finding {
  const file = input.file ?? null;
  const line = input.line ?? null;
  const ruleId = input.ruleId ?? null;
  return {
    ...input,
    file,
    line,
    ruleId,
    suggestion: input.suggestion ?? null,
    id: findingId(input.source, file, line, ruleId ?? input.message),
  };
}

export type RiskLevel = "low" | "medium" | "high" | "critical";

export const SEVERITY_WEIGHT: Record<ReviewIssue["severity"], number> = { critical: 4, high: 2.5, medium: 1, low: 0.3 };
