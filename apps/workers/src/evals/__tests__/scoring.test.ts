import { describe, it, expect } from "vitest";
import { makeFinding } from "@codeguard/review-engine";
import type { Finding } from "@codeguard/review-engine";
import { addedLineNumbers, aggregateMetrics, countChanges, findRegressions, scoreCase } from "../scoring.js";
import type { ExpectedIssue, Metrics } from "../scoring.js";

function finding(file: string | null, line: number | null, severity: Finding["severity"] = "high", message = "problem"): Finding {
  return makeFinding({ source: "security", severity, category: "security", file, line, message, confidence: 0.9, deterministic: false });
}

const bug: ExpectedIssue = { file: "src/a.ts", lines: [10, 12], category: "security", minSeverity: "high" };

describe("scoreCase", () => {
  it("counts a finding inside the expected range as a true positive", () => {
    const s = scoreCase("c", [finding("src/a.ts", 11)], [bug]);
    expect(s).toMatchObject({ truePositives: 1, falsePositives: 0, falseNegatives: 0 });
  });

  it("accepts a finding a few lines off, but not further than the tolerance", () => {
    expect(scoreCase("c", [finding("src/a.ts", 15)], [bug], 3).truePositives).toBe(1);
    expect(scoreCase("c", [finding("src/a.ts", 16)], [bug], 3)).toMatchObject({ truePositives: 0, falsePositives: 1, falseNegatives: 1 });
  });

  it("needs the same file (after stripping ./ and a/ prefixes)", () => {
    expect(scoreCase("c", [finding("./src/a.ts", 10)], [bug]).truePositives).toBe(1);
    expect(scoreCase("c", [finding("src/b.ts", 10)], [bug])).toMatchObject({ truePositives: 0, falsePositives: 1 });
  });

  it("does not let a file-level finding with no line claim a bug", () => {
    expect(scoreCase("c", [finding("src/a.ts", null)], [bug])).toMatchObject({ truePositives: 0, falsePositives: 1, falseNegatives: 1 });
  });

  it("counts a second report of a matched bug as a duplicate, not a false positive", () => {
    const s = scoreCase("c", [finding("src/a.ts", 10), finding("src/a.ts", 12, "medium", "same bug, other words")], [bug]);
    expect(s).toMatchObject({ truePositives: 1, duplicates: 1, falsePositives: 0 });
  });

  it("matches each bug with the closest finding", () => {
    const s = scoreCase("c", [finding("src/a.ts", 14), finding("src/a.ts", 11)], [bug]);
    expect(s.matches[0].finding.line).toBe(11);
  });

  it("treats every finding on a clean PR as a false positive and flags blocking ones", () => {
    const s = scoreCase("clean", [finding("src/a.ts", 3, "critical"), finding("src/a.ts", 30, "low")], []);
    expect(s).toMatchObject({ falsePositives: 2, blockingFalsePositives: 1 });
  });

  it("keeps PR-level findings out of the score", () => {
    const s = scoreCase("c", [finding(null, null, "medium", "PR is large")], [bug]);
    expect(s).toMatchObject({ falsePositives: 0, falseNegatives: 1 });
    expect(s.unscored).toHaveLength(1);
  });

  it("reports category agreement and under-severity on hits", () => {
    const low = makeFinding({ source: "quality", severity: "low", category: "bug", file: "src/a.ts", line: 10, message: "x", confidence: 0.9, deterministic: false });
    const s = scoreCase("c", [low], [bug]);
    expect(s.categoryAgreement).toEqual({ matched: 0, total: 1 });
    expect(s.underSeverity).toBe(1);
  });
});

describe("aggregateMetrics", () => {
  it("micro-averages precision, recall and F1 over all cases", () => {
    const a = scoreCase("a", [finding("src/a.ts", 10), finding("src/a.ts", 50)], [bug]); // 1 TP, 1 FP
    const b = scoreCase("b", [], [bug]); // 1 FN
    const clean = scoreCase("clean", [], []);
    const m = aggregateMetrics([a, b, clean], new Map([["a", 1], ["b", 1], ["clean", 0]]));
    expect(m).toMatchObject({ truePositives: 1, falsePositives: 1, falseNegatives: 1, precision: 0.5, recall: 0.5, f1: 0.5, cleanCasePassRate: 1 });
    expect(m.falsePositivesPerCase).toBeCloseTo(0.333, 3);
  });

  it("returns null precision when nothing was reported", () => {
    const m = aggregateMetrics([scoreCase("a", [], [bug])], new Map([["a", 1]]));
    expect(m.precision).toBeNull();
    expect(m.recall).toBe(0);
  });
});

describe("findRegressions", () => {
  const base = { precision: 0.8, recall: 0.7, blockingFalsePositives: 1 } as Metrics;

  it("passes small changes and improvements", () => {
    expect(findRegressions({ ...base, precision: 0.76, recall: 0.9 }, base)).toEqual([]);
  });

  it("fails when precision or recall drops past the limit", () => {
    const problems = findRegressions({ ...base, precision: 0.7, recall: 0.6 }, base);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/precision dropped/);
  });

  it("fails when more blocking false positives appear", () => {
    expect(findRegressions({ ...base, blockingFalsePositives: 2 }, base)[0]).toMatch(/blocking false positives/);
  });
});

describe("patch helpers", () => {
  const patch = "@@ -1,3 +1,4 @@\n a\n-b\n+c\n+d\n e";
  it("finds new-file line numbers of added lines", () => {
    expect([...addedLineNumbers(patch)]).toEqual([2, 3]);
  });
  it("counts additions and deletions", () => {
    expect(countChanges(patch)).toEqual({ additions: 2, deletions: 1 });
  });
});
