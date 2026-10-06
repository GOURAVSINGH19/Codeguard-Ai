import { SEVERITIES } from "@codeguard/types";
import { severityAtLeast } from "../repo-config";
import type { RepoConfig } from "../repo-config";
import type { VerificationOutput } from "../verify";
import type { Finding } from "./types";

// ─── aggregate_findings ──────────────────────────────────────────────────────

/**
 * Merge every stage's findings and keep only file/line references that exist
 * in the diff. A finding on an unknown file becomes a PR-level finding.
 */
export function aggregateFindings(groups: Finding[][], knownFiles: Set<string>): Finding[] {
  return groups.flat().map((f) => {
    if (!f.file) return { ...f, line: null };
    const candidate = f.file.replace(/^\.\//, "").replace(/^[ab]\//, "");
    if (knownFiles.has(candidate)) return { ...f, file: candidate };
    const suffix = [...knownFiles].filter((k) => k.endsWith(`/${candidate}`));
    return suffix.length === 1 ? { ...f, file: suffix[0] } : { ...f, file: null, line: null };
  });
}

// ─── deduplicate_findings ────────────────────────────────────────────────────

const STOP = new Set(["the", "a", "an", "is", "are", "to", "of", "in", "and", "or", "this", "that", "it", "be", "on", "for", "with", "as", "can", "may", "not", "if"]);

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9_ ]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2 && !STOP.has(t))
  );
}

export function similarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / Math.min(ta.size, tb.size);
}

const RANK = (s: Finding["severity"]) => SEVERITIES.length - SEVERITIES.indexOf(s);

function isDuplicate(a: Finding, b: Finding): boolean {
  if (a.file !== b.file) return false;
  if (a.ruleId && a.ruleId === b.ruleId) return a.line === b.line;
  const near = a.line === null || b.line === null ? a.line === b.line : Math.abs(a.line - b.line) <= 3;
  if (!near) return false;
  const threshold = a.category === b.category ? 0.45 : 0.65;
  return similarity(a.message, b.message) >= threshold;
}

/**
 * Collapse findings that describe the same problem at the same place. The
 * kept finding has the highest severity (then confidence); agreement between
 * independent sources raises its confidence.
 */
export function deduplicateFindings(findings: Finding[]): { findings: Finding[]; removed: number } {
  const sorted = [...findings].sort((a, b) => RANK(b.severity) - RANK(a.severity) || b.confidence - a.confidence);
  const kept: Finding[] = [];
  for (const f of sorted) {
    const dup = kept.find((k) => isDuplicate(k, f));
    if (!dup) {
      kept.push({ ...f });
      continue;
    }
    if (f.source !== dup.source) {
      dup.alsoReportedBy = [...new Set([...(dup.alsoReportedBy ?? []), f.source])];
      dup.confidence = Math.min(1, dup.confidence + (1 - dup.confidence) * 0.5);
    }
    if (!dup.suggestion && f.suggestion) dup.suggestion = f.suggestion;
  }
  return { findings: kept, removed: findings.length - kept.length };
}

// ─── verification_planner ────────────────────────────────────────────────────

export interface VerificationPlan {
  /** Sent to the independent verifier. */
  verify: Finding[];
  /** High-confidence deterministic findings — no model check needed. */
  trusted: Finding[];
  /** Over the verification budget, or below the severity floor: kept unverified. */
  unverified: Finding[];
  /** Dropped before verification: below min_severity. */
  dropped: Finding[];
}

export function planVerification(findings: Finding[], config: RepoConfig, maxToVerify = 25): VerificationPlan {
  const plan: VerificationPlan = { verify: [], trusted: [], unverified: [], dropped: [] };
  const ordered = [...findings].sort((a, b) => RANK(b.severity) - RANK(a.severity) || b.confidence - a.confidence);
  for (const f of ordered) {
    if (!severityAtLeast(f.severity, config.min_severity)) plan.dropped.push(f);
    else if (f.deterministic && f.confidence >= 0.9) plan.trusted.push({ ...f, verification: "trusted" });
    // PR-level process findings (size, cohesion…) cannot be checked against the diff.
    else if (!f.file && f.deterministic) plan.trusted.push({ ...f, verification: "trusted" });
    else if (plan.verify.length < maxToVerify) plan.verify.push(f);
    else plan.unverified.push({ ...f, verification: "unverified", confidence: f.confidence * 0.8 });
  }
  return plan;
}

// ─── independent_verify (applying the verdicts) ─────────────────────────────

export interface VerifiedFindings {
  findings: Finding[];
  confirmed: number;
  uncertain: number;
  rejected: Array<{ id: string; message: string; file: string | null; line: number | null; reason: string }>;
}

/**
 * Confirmed → confidence ≥ 0.9. Uncertain or missing verdict → one severity
 * lower and less confident. Rejected → removed.
 */
export function applyFindingVerdicts(findings: Finding[], output: VerificationOutput): VerifiedFindings {
  const byId = new Map(output.verdicts.map((v) => [v.id, v]));
  const result: VerifiedFindings = { findings: [], confirmed: 0, uncertain: 0, rejected: [] };
  findings.forEach((f, idx) => {
    const v = byId.get(idx);
    if (v?.verdict === "rejected") {
      result.rejected.push({ id: f.id, message: f.message, file: f.file, line: f.line, reason: v.reason });
    } else if (v?.verdict === "confirmed") {
      result.confirmed++;
      result.findings.push({ ...f, verification: "confirmed", confidence: Math.max(f.confidence, 0.9) });
    } else {
      result.uncertain++;
      const lower = SEVERITIES[Math.min(SEVERITIES.indexOf(f.severity) + 1, SEVERITIES.length - 1)];
      result.findings.push({ ...f, severity: lower, verification: "uncertain", confidence: f.confidence * 0.7 });
    }
  });
  return result;
}

/** Final filter before scoring: min_severity and min_confidence. */
export function filterForReport(findings: Finding[], config: RepoConfig): { kept: Finding[]; filtered: Finding[] } {
  const kept: Finding[] = [];
  const filtered: Finding[] = [];
  for (const f of findings) {
    const ok = severityAtLeast(f.severity, config.min_severity) && f.confidence >= config.policy.min_confidence;
    (ok ? kept : filtered).push(f);
  }
  kept.sort((a, b) => RANK(b.severity) - RANK(a.severity) || b.confidence - a.confidence);
  return { kept, filtered };
}
