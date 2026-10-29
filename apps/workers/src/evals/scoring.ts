import { z } from "zod";
import { SEVERITIES } from "@codeguard/types";
import type { Finding } from "@codeguard/review-engine";

/**
 * Scoring for the review eval set: did the pipeline find the planted bugs
 * (recall), and was what it reported real (precision)?
 *
 * Pure functions only, so the scoring rules are unit-tested without a model.
 */

// ─── Case files ──────────────────────────────────────────────────────────────

export const ExpectedIssueSchema = z.object({
  file: z.string().min(1),
  /** Inclusive new-file line range where the bug lives. */
  lines: z.tuple([z.number().int().positive(), z.number().int().positive()]).refine(([a, b]) => a <= b, "start must be <= end"),
  /** Informational: whether the reviewer labelled it the same way is reported, not required for a hit. */
  category: z.enum(["security", "bug", "performance", "maintainability", "style"]).optional(),
  /** Lowest severity a correct report should have; lower ones still count as a hit but are reported. */
  minSeverity: z.enum(SEVERITIES).optional(),
  note: z.string().optional(),
});
export type ExpectedIssue = z.infer<typeof ExpectedIssueSchema>;

export const EvalCaseSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, "lowercase letters, digits and dashes"),
  title: z.string().min(1),
  body: z.string().default(""),
  files: z
    .array(
      z.object({
        filename: z.string().min(1),
        status: z.enum(["added", "modified", "removed", "renamed"]).default("modified"),
        patch: z.string().min(1),
        /** Full file at the PR head; enables the import graph and changed-symbol detection. */
        content: z.string().optional(),
      })
    )
    .min(1),
  /**
   * Other repository files the PR does not change (callers, imported types).
   * With these the harness builds the import graph and the code context, as
   * the worker does on an indexed repository.
   */
  repoFiles: z.array(z.object({ path: z.string().min(1), content: z.string() })).default([]),
  /** Empty = a clean PR: every scored finding is a false positive. */
  expected: z.array(ExpectedIssueSchema).default([]),
  tags: z.array(z.string()).default([]),
});
export type EvalCase = z.infer<typeof EvalCaseSchema>;

// ─── Matching ────────────────────────────────────────────────────────────────

/** A finding this many lines outside the expected range still counts. Models are often off by a line or two. */
export const DEFAULT_LINE_TOLERANCE = 3;

export interface ScoredFinding {
  file: string;
  line: number | null;
  severity: Finding["severity"];
  category: Finding["category"];
  source: Finding["source"];
  message: string;
  verification?: Finding["verification"];
}

export interface CaseScore {
  caseId: string;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  /** Extra reports of a bug that was already matched: noise, but not a wrong claim. */
  duplicates: number;
  /** False positives at high/critical severity: the ones that could wrongly fail a Check Run. */
  blockingFalsePositives: number;
  /** Hits whose category matched the expected one (only counted when the case gives a category). */
  categoryAgreement: { matched: number; total: number };
  /** Hits reported below the case's minSeverity. */
  underSeverity: number;
  matches: Array<{ expected: ExpectedIssue; finding: ScoredFinding }>;
  missed: ExpectedIssue[];
  falsePositiveFindings: ScoredFinding[];
  /** PR-level findings (no file) are listed but not scored: they can't be placed against a line. */
  unscored: ScoredFinding[];
}

const SEVERITY_RANK: Record<Finding["severity"], number> = { critical: 4, high: 3, medium: 2, low: 1 };

function normalizePath(path: string): string {
  return path.replace(/^\.\//, "").replace(/^[ab]\//, "");
}

/** Lines between the finding and the expected range; 0 = inside it. */
function distance(line: number, [start, end]: [number, number]): number {
  if (line < start) return start - line;
  if (line > end) return line - end;
  return 0;
}

function canMatch(finding: ScoredFinding, expected: ExpectedIssue, tolerance: number): boolean {
  if (normalizePath(finding.file) !== normalizePath(expected.file)) return false;
  // A file-level finding is too vague to prove it saw this bug.
  if (finding.line === null) return false;
  return distance(finding.line, expected.lines) <= tolerance;
}

export function toScored(f: Finding): ScoredFinding | null {
  if (!f.file) return null;
  return { file: f.file, line: f.line, severity: f.severity, category: f.category, source: f.source, message: f.message, verification: f.verification };
}

/**
 * Match findings to expected bugs. Each expected bug is matched at most once,
 * by the closest finding (most severe on ties); every other finding near an
 * already-matched bug is a duplicate, and everything else is a false positive.
 */
export function scoreCase(caseId: string, findings: Finding[], expected: ExpectedIssue[], tolerance = DEFAULT_LINE_TOLERANCE): CaseScore {
  const scored: ScoredFinding[] = [];
  const unscored: ScoredFinding[] = [];
  for (const f of findings) {
    const s = toScored(f);
    if (s) scored.push(s);
    else unscored.push({ file: "PR", line: null, severity: f.severity, category: f.category, source: f.source, message: f.message, verification: f.verification });
  }

  const used = new Set<number>();
  const matches: CaseScore["matches"] = [];
  const missed: ExpectedIssue[] = [];
  for (const exp of expected) {
    let best = -1;
    for (let i = 0; i < scored.length; i++) {
      if (used.has(i) || !canMatch(scored[i], exp, tolerance)) continue;
      if (best === -1) {
        best = i;
        continue;
      }
      const d = distance(scored[i].line!, exp.lines) - distance(scored[best].line!, exp.lines);
      if (d < 0 || (d === 0 && SEVERITY_RANK[scored[i].severity] > SEVERITY_RANK[scored[best].severity])) best = i;
    }
    if (best === -1) missed.push(exp);
    else {
      used.add(best);
      matches.push({ expected: exp, finding: scored[best] });
    }
  }

  let duplicates = 0;
  const falsePositiveFindings: ScoredFinding[] = [];
  scored.forEach((f, i) => {
    if (used.has(i)) return;
    if (matches.some((m) => canMatch(f, m.expected, tolerance))) duplicates++;
    else falsePositiveFindings.push(f);
  });

  const withCategory = matches.filter((m) => m.expected.category);
  return {
    caseId,
    truePositives: matches.length,
    falsePositives: falsePositiveFindings.length,
    falseNegatives: missed.length,
    duplicates,
    blockingFalsePositives: falsePositiveFindings.filter((f) => SEVERITY_RANK[f.severity] >= SEVERITY_RANK.high).length,
    categoryAgreement: { matched: withCategory.filter((m) => m.finding.category === m.expected.category).length, total: withCategory.length },
    underSeverity: matches.filter((m) => m.expected.minSeverity && SEVERITY_RANK[m.finding.severity] < SEVERITY_RANK[m.expected.minSeverity]).length,
    matches,
    missed,
    falsePositiveFindings,
    unscored,
  };
}

// ─── Totals ──────────────────────────────────────────────────────────────────

export interface Metrics {
  cases: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  duplicates: number;
  blockingFalsePositives: number;
  /** null when nothing was reported at all. */
  precision: number | null;
  /** null when the set has no planted bugs. */
  recall: number | null;
  f1: number | null;
  falsePositivesPerCase: number;
  categoryAgreement: number | null;
  /** Share of clean cases (no expected bugs) with zero false positives. */
  cleanCasePassRate: number | null;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** Micro-averaged over all cases: every finding and every bug weighs the same. */
export function aggregateMetrics(scores: CaseScore[], expectedCounts: Map<string, number>): Metrics {
  const sum = (pick: (s: CaseScore) => number) => scores.reduce((n, s) => n + pick(s), 0);
  const tp = sum((s) => s.truePositives);
  const fp = sum((s) => s.falsePositives);
  const fn = sum((s) => s.falseNegatives);
  const precision = tp + fp === 0 ? null : tp / (tp + fp);
  const recall = tp + fn === 0 ? null : tp / (tp + fn);
  const f1 = precision !== null && recall !== null && precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : null;
  const catTotal = sum((s) => s.categoryAgreement.total);
  const clean = scores.filter((s) => (expectedCounts.get(s.caseId) ?? 0) === 0);
  return {
    cases: scores.length,
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
    duplicates: sum((s) => s.duplicates),
    blockingFalsePositives: sum((s) => s.blockingFalsePositives),
    precision: precision === null ? null : round(precision),
    recall: recall === null ? null : round(recall),
    f1: f1 === null ? null : round(f1),
    falsePositivesPerCase: scores.length === 0 ? 0 : round(fp / scores.length),
    categoryAgreement: catTotal === 0 ? null : round(sum((s) => s.categoryAgreement.matched) / catTotal),
    cleanCasePassRate: clean.length === 0 ? null : round(clean.filter((s) => s.falsePositives === 0).length / clean.length),
  };
}

// ─── Regression gate ─────────────────────────────────────────────────────────

export interface RegressionLimits {
  /** Largest allowed drop, in points of 0..1 (0.05 = five percentage points). */
  maxPrecisionDrop: number;
  maxRecallDrop: number;
}

export const DEFAULT_REGRESSION_LIMITS: RegressionLimits = { maxPrecisionDrop: 0.05, maxRecallDrop: 0.05 };

/** Human-readable reasons the current run is worse than the baseline; empty = pass. */
export function findRegressions(current: Metrics, baseline: Metrics, limits: RegressionLimits = DEFAULT_REGRESSION_LIMITS): string[] {
  const problems: string[] = [];
  const check = (name: "precision" | "recall", maxDrop: number) => {
    const now = current[name];
    const before = baseline[name];
    if (now === null || before === null) return;
    if (before - now > maxDrop + 1e-9) problems.push(`${name} dropped from ${before.toFixed(3)} to ${now.toFixed(3)} (allowed drop ${maxDrop.toFixed(3)})`);
  };
  check("precision", limits.maxPrecisionDrop);
  check("recall", limits.maxRecallDrop);
  if (current.blockingFalsePositives > baseline.blockingFalsePositives) {
    problems.push(`blocking false positives rose from ${baseline.blockingFalsePositives} to ${current.blockingFalsePositives}`);
  }
  return problems;
}

// ─── Patch helpers (used to validate case files) ────────────────────────────

/** New-file line numbers of the added lines in a unified diff patch. */
export function addedLineNumbers(patch: string): Set<number> {
  const lines = new Set<number>();
  let next = 0;
  for (const raw of patch.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      next = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith("+")) lines.add(next++);
    else if (raw.startsWith("-")) continue;
    else next++;
  }
  return lines;
}

export function countChanges(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { additions, deletions };
}
