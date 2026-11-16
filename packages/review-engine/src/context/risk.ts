/**
 * Stage 2: how risky is this change?  Scored by CODE, not by the model:
 * the same change always gets the same risk, and every point has a reason
 * (`factors`) we can show to people.
 */
export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface RiskInput {
  changedPaths: string[];
  affectedCount: number; // blast radius size
  maxFanIn: number; // most-imported changed file
  linesChanged: number;
  deletedTestFiles: number;
}

export interface Risk {
  score: number; // 0–100
  level: RiskLevel;
  factors: string[];
}

export const CRITICAL_PATH = /(^|\/)(auth|login|session|jwt|token|oauth|password|crypto|secret|payment|billing|checkout|permission|rbac|acl|migrations?|security|middleware)[^/]*/i;

export function assessRisk(input: RiskInput): Risk {
  const factors: string[] = [];
  let score = 0;

  const blast = Math.min(35, input.affectedCount * 2);
  if (blast > 0) {
    score += blast;
    factors.push(`${input.affectedCount} file(s) depend on the changed code`);
  }
  if (input.maxFanIn >= 10) {
    score += 10;
    factors.push(`a changed file is imported directly by ${input.maxFanIn} files`);
  }

  const critical = input.changedPaths.filter((p) => CRITICAL_PATH.test(p));
  if (critical.length) {
    score += 30;
    factors.push(`touches sensitive code: ${critical.slice(0, 3).join(", ")}${critical.length > 3 ? "…" : ""}`);
  }

  const size = Math.min(15, Math.floor(input.linesChanged / 50) * 3);
  if (size > 0) {
    score += size;
    factors.push(`${input.linesChanged} lines changed`);
  }
  if (input.deletedTestFiles > 0) {
    score += 10;
    factors.push(`${input.deletedTestFiles} test file(s) deleted`);
  }

  score = Math.min(100, score);
  const level: RiskLevel = score >= 70 ? "critical" : score >= 45 ? "high" : score >= 20 ? "medium" : "low";
  if (!factors.length) factors.push("small, isolated change");
  return { score, level, factors };
}
