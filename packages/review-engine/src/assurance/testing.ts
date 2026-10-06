import { classifyFile } from "./change";
import { makeFinding } from "./types";
import type { Finding } from "./types";
import type { PRFileInput } from "../diff";
import type { PolicyConfig } from "../repo-config";

/**
 * Stage 3 · testing. Two signals that need no code execution:
 *  1. Did the PR change source without touching any test for it?
 *  2. What did the repository's own CI report for this commit?
 *     (We read check results through the GitHub API; we never run the
 *     PR's tests ourselves, because that would execute untrusted code.)
 */

export interface CheckResult {
  name: string;
  /** "queued" | "in_progress" | "completed" … */
  status: string;
  /** "success" | "failure" | "timed_out" | "cancelled" | "neutral" | "skipped" | "action_required" | null */
  conclusion: string | null;
  url?: string | null;
}

export interface TestingReport {
  sourceFilesChanged: string[];
  testFilesChanged: string[];
  /** Changed source files with no changed test that looks related. */
  untestedFiles: string[];
  ci: { passed: number; failed: string[]; pending: string[]; total: number };
  /** 0..10 */
  score: number;
}

const FAILED = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure"]);

function stem(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base
    .replace(/\.(test|spec)(?=\.)/i, "")
    .replace(/_test(?=\.)/i, "")
    .replace(/^test_/i, "")
    .replace(/Tests?(?=\.)/, "")
    .replace(/\.[^.]+$/, "")
    .toLowerCase();
}

/** Source files whose changes rarely need a test of their own. */
const NO_TEST_NEEDED = /\.(css|scss|sass|less|svg|png|jpe?g|gif|json|ya?ml|toml|ini|lock|html)$|(^|\/)(types?|constants?|index)\.(ts|js)$|\.d\.ts$|(^|\/)(migrations?|config)\//i;

export function analyzeTesting(files: PRFileInput[], checks: CheckResult[], policy: PolicyConfig): { report: TestingReport; findings: Finding[] } {
  const sourceFilesChanged = files.filter((f) => f.status !== "removed" && classifyFile(f.filename) === "source").map((f) => f.filename);
  const testFilesChanged = files.filter((f) => classifyFile(f.filename) === "test").map((f) => f.filename);
  const testStems = new Set(testFilesChanged.map(stem));

  const needsTests = sourceFilesChanged.filter((f) => !NO_TEST_NEEDED.test(f));
  const untestedFiles = needsTests.filter((f) => !testStems.has(stem(f)));

  const failed = checks.filter((c) => c.status === "completed" && c.conclusion && FAILED.has(c.conclusion));
  const pending = checks.filter((c) => c.status !== "completed");
  const passed = checks.filter((c) => c.status === "completed" && c.conclusion === "success").length;

  const findings: Finding[] = [];
  for (const check of failed) {
    findings.push(
      makeFinding({
        source: "testing",
        severity: "high",
        category: "bug",
        message: `CI check "${check.name}" ${check.conclusion === "timed_out" ? "timed out" : "failed"} on this commit${check.url ? ` (${check.url})` : ""}.`,
        suggestion: "Fix the failing check before merging.",
        confidence: 1,
        ruleId: `ci/${check.name}`,
        deterministic: true,
      })
    );
  }

  if (policy.require_tests !== "off" && needsTests.length > 0 && testFilesChanged.length === 0) {
    findings.push(
      makeFinding({
        source: "testing",
        severity: policy.require_tests === "block" ? "high" : "medium",
        category: "maintainability",
        message: `${needsTests.length} source file(s) changed but no tests were added or updated (${needsTests.slice(0, 5).join(", ")}${needsTests.length > 5 ? ", …" : ""}).`,
        suggestion: "Add or update tests that cover the new behaviour.",
        confidence: 0.9,
        ruleId: "testing/no-tests",
        deterministic: true,
      })
    );
  }

  // Score: start at 10, lose points for failing CI and untested source.
  const coverage = needsTests.length === 0 ? 1 : 1 - untestedFiles.length / needsTests.length;
  let score = 4 + 6 * coverage;
  score -= failed.length * 3;
  const report: TestingReport = {
    sourceFilesChanged,
    testFilesChanged,
    untestedFiles,
    ci: { passed, failed: failed.map((c) => c.name), pending: pending.map((c) => c.name), total: checks.length },
    score: Math.max(0, Math.min(10, Math.round(score * 10) / 10)),
  };
  return { report, findings };
}
