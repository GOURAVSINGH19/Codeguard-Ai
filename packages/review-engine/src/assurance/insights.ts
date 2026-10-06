import type { AssuranceDecision, PolicyResult, Scorecard } from "./decision";
import type { CohesionReport, CommitterProfile, VolumeReport } from "./change";
import type { BlastRadiusReport, CriticalityReport, RiskAssessment } from "./risk";
import type { TestingReport } from "./testing";
import type { AlignmentResult, BusinessIntent } from "./prompts";
import type { Finding } from "./types";

/**
 * generate_insights: turn the run's analysis into what a human reviewer
 * needs — a summary, concrete recommendations, and report sections for the
 * PR review and the Check Run. Deterministic; no extra model call.
 */

export interface InsightsInput {
  intent: BusinessIntent | null;
  alignment: AlignmentResult | null;
  committer: CommitterProfile;
  volume: VolumeReport;
  cohesion: CohesionReport;
  blast: BlastRadiusReport;
  criticality: CriticalityReport;
  risk: RiskAssessment;
  testing: TestingReport;
  scorecard: Scorecard;
  policies: PolicyResult[];
  decision: AssuranceDecision;
  findings: Finding[];
  /** One-line summaries from the stage reviewers. */
  stageSummaries: Partial<Record<"quality" | "security" | "testing", string>>;
}

export interface Insights {
  summary: string;
  recommendations: string[];
  /** Markdown sections for the PR review body. */
  sections: string[];
  /** Markdown for the Check Run summary. */
  checkSummary: string;
}

const VERDICT_ICON = { approve: "✅", comment: "💬", request_changes: "⛔" } as const;
const POLICY_ICON = { pass: "✅", warn: "⚠️", fail: "❌" } as const;
const RISK_ICON = { low: "🟢", medium: "🟡", high: "🟠", critical: "🔴" } as const;

export function generateInsights(input: InsightsInput): Insights {
  const recs: string[] = [];
  if (input.decision.verdict === "request_changes") recs.push(...input.policies.filter((p) => p.status === "fail").map((p) => `Resolve: ${p.message}.`));
  const crit = input.findings.filter((f) => f.severity === "critical");
  if (crit.length) recs.push(`Fix the ${crit.length} critical finding(s) first.`);
  if (input.volume.meaningfulLines > 800 || input.cohesion.clusters.length >= 3) recs.push("Consider splitting this PR into smaller, independent changes.");
  if (input.testing.untestedFiles.length > 0) recs.push(`Add tests for: ${input.testing.untestedFiles.slice(0, 4).join(", ")}${input.testing.untestedFiles.length > 4 ? ", …" : ""}.`);
  if (input.criticality.areas.length > 0 && input.committer.trust !== "maintainer") recs.push("Ask a maintainer who owns the critical areas touched here to review.");
  if (input.blast.hotspots.some((h) => h.dependents >= 10)) recs.push(`\`${input.blast.hotspots[0].path}\` is imported by ${input.blast.hotspots[0].dependents} files — check callers for breaking changes.`);
  if (input.alignment?.gaps.length) recs.push("Close the gaps between the description and the implementation, or update the description.");

  const intentLine = input.intent?.stated ? input.intent.summary : "The PR description does not state its purpose clearly.";
  const stage = [input.stageSummaries.quality, input.stageSummaries.security].filter(Boolean).join(" ");
  const summary = [intentLine, stage, `${input.decision.headline}.`].filter(Boolean).join(" ").trim();

  const sections = [
    decisionSection(input),
    scorecardSection(input.scorecard),
    riskSection(input),
    policySection(input.policies),
    recs.length ? `### Recommendations\n${recs.map((r) => `- ${r}`).join("\n")}` : "",
  ].filter(Boolean);

  const checkSummary = [
    `**${VERDICT_ICON[input.decision.verdict]} ${input.decision.headline}**`,
    `Overall score **${input.scorecard.overall.toFixed(1)}/10** · Risk ${RISK_ICON[input.risk.level]} ${input.risk.level} (${input.risk.score}/100)`,
    scorecardSection(input.scorecard),
    policySection(input.policies),
  ].join("\n\n");

  return { summary, recommendations: recs, sections, checkSummary };
}

function decisionSection(input: InsightsInput): string {
  const d = input.decision;
  const reasons = d.reasons.length ? `\n${d.reasons.map((r) => `- ${r}`).join("\n")}` : "";
  const intent = input.intent?.stated
    ? `\n\n**Intent:** ${input.intent.summary}${input.alignment ? ` — alignment: *${input.alignment.alignment}* (${input.alignment.score}/10)` : ""}`
    : "";
  return `### ${VERDICT_ICON[d.verdict]} Decision: ${d.verdict.replace("_", " ")}\n${d.headline}${reasons}${intent}`;
}

function scorecardSection(card: Scorecard): string {
  const rows = card.dimensions.map((d) => `| ${d.label} | ${d.score === null ? "—" : d.score.toFixed(1)} | ${escapeCell(d.note)} |`).join("\n");
  return `### Scorecard — ${card.overall.toFixed(1)} / 10\n| Dimension | Score | Notes |\n|---|---|---|\n${rows}`;
}

function riskSection(input: InsightsInput): string {
  const r = input.risk;
  const lines = [
    `**${RISK_ICON[r.level]} ${r.level.toUpperCase()} risk** (${r.score}/100)${r.factors.length ? ` — ${r.factors.slice(0, 5).join("; ")}` : ""}`,
    `- Size: ${input.volume.size} (${input.volume.meaningfulLines} lines, ${input.volume.files} files)`,
    input.blast.graphAvailable
      ? `- Blast radius: ${input.blast.directCount} direct / ${input.blast.transitiveCount} transitive dependents`
      : "- Blast radius: unknown (repository not indexed yet)",
    `- Author: ${input.committer.login ?? "unknown"} (${input.committer.trust})`,
  ];
  if (input.criticality.areas.length) lines.push(`- Critical areas: ${input.criticality.areas.map((a) => a.label).join(", ")}`);
  return `<details><summary>Risk analysis</summary>\n\n${lines.join("\n")}\n</details>`;
}

function policySection(policies: PolicyResult[]): string {
  if (policies.length === 0) return "";
  return `### Policy checks\n${policies.map((p) => `- ${POLICY_ICON[p.status]} ${p.message}`).join("\n")}`;
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 160);
}
