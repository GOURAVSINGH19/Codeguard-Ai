import type { VerifiedFinding } from "./verifier";

/**
 * Score by CODE from the verified findings, not by asking the model for a number:
 * the same findings always produce the same score.
 *   start at 100, subtract per finding; uncertain findings count half.
 */
export const WEIGHTS = { critical: 30, high: 15, medium: 6, low: 2 } as const;

const penalty = (fs: VerifiedFinding[]) =>
  fs.reduce((sum, f) => sum + WEIGHTS[f.severity] * (f.verdict === "uncertain" ? 0.5 : 1), 0);

export function overallScore(findings: VerifiedFinding[]): number {
  return Math.max(0, Math.round(100 - penalty(findings)));
}

export interface Dimension {
  id: string;
  label: string;
  score: number | null; // 0–10, shown in the UI with one decimal
  note: string;
}

export function dimensions(findings: VerifiedFinding[], failedReviewers: string[]): Dimension[] {
  const dim = (id: "quality" | "security" | "testing", label: string, pick: (f: VerifiedFinding) => boolean): Dimension => {
    if (failedReviewers.includes(id)) return { id, label, score: null, note: "reviewer failed; not scored" };
    const fs = findings.filter(pick);
    const score = Math.max(0, Math.round((10 - penalty(fs) / 10) * 10) / 10);
    return { id, label, score, note: fs.length ? `${fs.length} finding(s)` : "no issues found" };
  };
  return [
    dim("quality", "Correctness & quality", (f) => f.reviewer === "quality" || f.reviewer === "eslint"),
    dim("security", "Security", (f) => f.reviewer === "security" || f.category === "security"),
    dim("testing", "Testing", (f) => f.reviewer === "testing"),
  ];
}
