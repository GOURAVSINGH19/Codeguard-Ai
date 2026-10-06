import { severityAtLeast } from "../repo-config";
import type { CheckConclusion, RepoConfig } from "../repo-config";
import { SEVERITY_WEIGHT } from "./types";
import type { Finding } from "./types";
import type { RiskAssessment } from "./risk";
import type { CohesionReport, CommitterProfile, VolumeReport } from "./change";
import type { CriticalityReport } from "./risk";
import type { TestingReport } from "./testing";

// ─── scorecard ───────────────────────────────────────────────────────────────

export interface ScoreDimension {
  id: "intent" | "scope" | "risk" | "quality" | "security" | "testing";
  label: string;
  /** 0..10, null when there was nothing to measure (e.g. no stated intent). */
  score: number | null;
  weight: number;
  note: string;
}

export interface Scorecard {
  overall: number;
  dimensions: ScoreDimension[];
}

function findingScore(findings: Finding[]): number {
  const penalty = findings.reduce((sum, f) => sum + SEVERITY_WEIGHT[f.severity] * (0.5 + f.confidence / 2), 0);
  return Math.max(0, 10 - penalty);
}

export function buildScorecard(input: {
  findings: Finding[];
  alignment: { score: number; summary: string } | null;
  volume: VolumeReport;
  cohesion: CohesionReport;
  risk: RiskAssessment;
  testing: TestingReport;
}): Scorecard {
  const security = input.findings.filter((f) => f.category === "security");
  const quality = input.findings.filter((f) => f.category !== "security" && (f.source === "quality" || f.source === "align"));
  const sizePenalty = { XS: 0, S: 0, M: 0.5, L: 1.5, XL: 3, XXL: 4.5 }[input.volume.size];

  const dimensions: ScoreDimension[] = [
    { id: "quality", label: "Code quality", score: r1(findingScore(quality)), weight: 0.25, note: `${quality.length} finding(s)` },
    { id: "security", label: "Security", score: r1(findingScore(security)), weight: 0.25, note: `${security.length} finding(s)` },
    { id: "testing", label: "Testing", score: input.testing.score, weight: 0.15, note: input.testing.ci.failed.length ? `${input.testing.ci.failed.length} failing CI check(s)` : `${input.testing.untestedFiles.length} untested file(s)` },
    { id: "intent", label: "Matches stated intent", score: input.alignment ? r1(input.alignment.score) : null, weight: 0.15, note: input.alignment?.summary ?? "No description to compare against" },
    { id: "scope", label: "Scope & cohesion", score: r1(Math.max(0, 10 * input.cohesion.score - sizePenalty)), weight: 0.1, note: `size ${input.volume.size}, ${input.cohesion.clusters.length} change group(s)` },
    { id: "risk", label: "Change risk", score: r1(10 - input.risk.score / 10), weight: 0.1, note: `${input.risk.level} (${input.risk.score}/100)` },
  ];
  const measured = dimensions.filter((d) => d.score !== null);
  const totalWeight = measured.reduce((s, d) => s + d.weight, 0);
  const overall = r1(measured.reduce((s, d) => s + d.score! * d.weight, 0) / totalWeight);
  return { overall, dimensions };
}

// ─── policy_evaluation ───────────────────────────────────────────────────────

export interface PolicyResult {
  id: string;
  status: "pass" | "warn" | "fail";
  message: string;
}

export function evaluatePolicies(input: {
  config: RepoConfig;
  findings: Finding[];
  scorecard: Scorecard;
  volume: VolumeReport;
  testing: TestingReport;
  committer: CommitterProfile;
  criticality: CriticalityReport;
}): PolicyResult[] {
  const { config, findings } = input;
  const p = config.policy;
  const results: PolicyResult[] = [];

  if (config.fail_on !== "never") {
    const blocking = findings.filter((f) => severityAtLeast(f.severity, config.fail_on as Finding["severity"]));
    results.push(
      blocking.length > 0
        ? { id: "severity-gate", status: "fail", message: `${blocking.length} finding(s) at or above "${config.fail_on}"` }
        : { id: "severity-gate", status: "pass", message: `No findings at or above "${config.fail_on}"` }
    );
  }

  const secrets = findings.filter((f) => f.ruleId?.startsWith("secret/"));
  if (secrets.length > 0) {
    results.push({ id: "secrets", status: p.block_secrets ? "fail" : "warn", message: `${secrets.length} possible credential(s) in the diff` });
  } else {
    results.push({ id: "secrets", status: "pass", message: "No credentials detected" });
  }

  if (p.require_tests !== "off") {
    const missing = findings.some((f) => f.ruleId === "testing/no-tests");
    results.push(
      missing
        ? { id: "tests", status: p.require_tests === "block" ? "fail" : "warn", message: "Source changed without test changes" }
        : { id: "tests", status: "pass", message: "Tests accompany the source changes" }
    );
  }

  if (input.testing.ci.failed.length > 0) {
    results.push({ id: "ci", status: "warn", message: `Failing CI: ${input.testing.ci.failed.join(", ")}` });
  } else if (input.testing.ci.pending.length > 0) {
    results.push({ id: "ci", status: "warn", message: `CI still running: ${input.testing.ci.pending.join(", ")}` });
  }

  results.push(
    input.volume.meaningfulLines > p.max_changed_lines
      ? { id: "size", status: "warn", message: `${input.volume.meaningfulLines} lines changed (limit ${p.max_changed_lines})` }
      : { id: "size", status: "pass", message: `${input.volume.meaningfulLines} lines changed` }
  );

  if (p.min_score !== null) {
    results.push(
      input.scorecard.overall < p.min_score
        ? { id: "min-score", status: "fail", message: `Score ${input.scorecard.overall} is below the required ${p.min_score}` }
        : { id: "min-score", status: "pass", message: `Score ${input.scorecard.overall} meets the required ${p.min_score}` }
    );
  }

  if (input.committer.trust === "newcomer" && input.criticality.criticalFiles.length > 0) {
    results.push({ id: "newcomer-critical", status: "warn", message: "First-time contributor changes critical code — needs a maintainer's review" });
  }
  return results;
}

// ─── assurance_decision ──────────────────────────────────────────────────────

export type AssuranceVerdict = "approve" | "comment" | "request_changes";

export interface AssuranceDecision {
  verdict: AssuranceVerdict;
  conclusion: CheckConclusion;
  /** One line for the report header. */
  headline: string;
  reasons: string[];
}

export function decideAssurance(input: { policies: PolicyResult[]; findings: Finding[]; risk: RiskAssessment }): AssuranceDecision {
  const failed = input.policies.filter((p) => p.status === "fail");
  const warned = input.policies.filter((p) => p.status === "warn");
  const significant = input.findings.filter((f) => severityAtLeast(f.severity, "medium"));

  if (failed.length > 0) {
    return {
      verdict: "request_changes",
      conclusion: "failure",
      headline: "Changes requested — blocking policy checks failed",
      reasons: failed.map((p) => p.message),
    };
  }
  if (warned.length > 0 || significant.length > 0 || input.risk.level === "critical") {
    const reasons = [...warned.map((p) => p.message)];
    if (significant.length > 0) reasons.push(`${significant.length} finding(s) of medium severity or higher`);
    if (input.risk.level === "critical") reasons.push("critical-risk change — a human review is required");
    return { verdict: "comment", conclusion: "neutral", headline: "Review needed — no blockers, but look at the notes", reasons };
  }
  return { verdict: "approve", conclusion: "success", headline: "Looks good — no blocking or significant findings", reasons: [] };
}

function r1(n: number): number {
  return Math.round(n * 10) / 10;
}
