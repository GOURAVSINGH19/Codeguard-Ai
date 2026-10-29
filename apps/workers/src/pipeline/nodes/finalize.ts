import { TOPICS, prMessageKey } from "@codeguard/kafka";
import type { ReviewCompletedEvent } from "@codeguard/kafka";
import {
  buildScorecard,
  createCheckRun,
  decideAssurance,
  evaluatePolicies,
  generateInsights,
  postReview,
} from "@codeguard/review-engine";
import type { PipelineStep } from "@codeguard/review-engine";
import { getWorkerProducer } from "../../queue/kafkaClient.js";
import { withRetry } from "../../lib/retry.js";
import { patchReviewMetadata, saveCompletedReview } from "../store.js";
import type { ReviewRunState } from "../state.js";

type Step = PipelineStep<ReviewRunState>;

export { aggregateFindingsNode, deduplicateFindingsNode, independentVerify, verificationPlanner } from "./findings.js";

export const scorecardNode: Step = {
  name: "scorecard",
  async run(s) {
    s.scorecard = buildScorecard({
      findings: s.findings,
      alignment: s.alignment ? { score: s.alignment.score, summary: s.alignment.summary } : null,
      volume: s.volume!,
      cohesion: s.cohesion,
      risk: s.risk!,
      testing: s.testing!,
    });
  },
};

export const policyEvaluation: Step = {
  name: "policy_evaluation",
  async run(s) {
    s.policies = evaluatePolicies({
      config: s.config,
      findings: s.findings,
      scorecard: s.scorecard!,
      volume: s.volume!,
      testing: s.testing!,
      committer: s.committer,
      criticality: s.criticality,
    });
  },
};

export const assuranceDecision: Step = {
  name: "assurance_decision",
  async run(s) {
    s.decision = decideAssurance({ policies: s.policies, findings: s.findings, risk: s.risk! });
  },
};

export const generateInsightsNode: Step = {
  name: "generate_insights",
  async run(s) {
    s.insights = generateInsights({
      intent: s.intent,
      alignment: s.alignment,
      committer: s.committer,
      volume: s.volume!,
      cohesion: s.cohesion,
      blast: s.blast,
      criticality: s.criticality,
      risk: s.risk!,
      testing: s.testing!,
      scorecard: s.scorecard!,
      policies: s.policies,
      decision: s.decision!,
      findings: s.findings,
      stageSummaries: s.stageSummaries,
    });
  },
};

/**
 * Save first (the review is "completed" from here on), then publish. GitHub
 * and Kafka failures are recorded, not retried: a retry would post a second
 * review on the PR.
 */
export const publishReport: Step = {
  name: "publish_report",
  async run(s) {
    await saveCompletedReview(s, resultMetadata(s));

    const github: Record<string, unknown> = {};
    if (s.publishToGitHub) {
      const { owner, repo, pullNumber } = s.event;
      const onRetry = (what: string) => (err: unknown, attempt: number, delayMs: number) =>
        s.log.warn(`${what} failed, retrying`, { attempt, delayMs, error: (err as Error).message });

      try {
        const posted = await withRetry(
          () =>
            postReview(s.octokit, {
              owner,
              repo,
              pullNumber,
              commitId: s.headSha,
              score: s.scorecard!.overall,
              summary: s.insights!.summary,
              headline: `**Score:** \`${s.scorecard!.overall.toFixed(1)} / 10\` · **Risk:** ${s.risk!.level} · **Findings:** ${s.findings.length}`,
              sections: s.insights!.sections,
              issues: s.findings,
              commentable: s.commentable,
              notes: scopeNotes(s),
              footer: "CodeGuard AI · staged assurance review",
            }),
          { onRetry: onRetry("posting the review to GitHub") }
        );
        s.published = true;
        s.githubReview = { id: posted.id, url: posted.htmlUrl, mode: posted.mode, inlineCount: posted.inlineCount };
        Object.assign(github, { reviewId: posted.id, url: posted.htmlUrl, mode: posted.mode, inlineCount: posted.inlineCount });
      } catch (err) {
        s.log.error("posting the review to GitHub failed", { error: (err as Error).message });
        github.error = (err as Error).message.slice(0, 300);
      }

      try {
        await withRetry(
          () =>
            createCheckRun(s.octokit, {
              owner,
              repo,
              headSha: s.headSha,
              conclusion: s.decision!.conclusion,
              score: s.scorecard!.overall,
              issues: s.findings,
              failOn: s.config.fail_on,
              title: s.decision!.headline,
              summary: s.insights!.checkSummary,
            }),
          { onRetry: onRetry("creating the check run") }
        );
      } catch (err) {
        s.log.error("check run not created (a 403/404 usually means the App lacks checks:write)", { error: (err as Error).message });
        github.checkRunError = (err as Error).message.slice(0, 300);
      }

      // The review itself is saved, but the PR may have nothing to show for it.
      // Record that on the row so it is not mistaken for a clean publish.
      github.publishStatus = publishStatus(github);
      if (github.publishStatus !== "published") s.log.error("review saved but not fully published to GitHub", { publishStatus: github.publishStatus });
      await patchReviewMetadata(s.reviewId!, { github, conclusion: s.decision!.conclusion }).catch(() => {});
    }

    try {
      const completed: ReviewCompletedEvent = {
        reviewId: s.reviewId!,
        prNumber: s.event.pullNumber,
        owner: s.event.owner,
        repo: s.event.repo,
        score: s.scorecard!.overall,
        issueCount: s.findings.length,
        userId: s.event.userId,
        completedAt: new Date().toISOString(),
      };
      const producer = await getWorkerProducer();
      await producer.send({
        topic: TOPICS.REVIEW_COMPLETED,
        messages: [{ key: prMessageKey(s.event.owner, s.event.repo, s.event.pullNumber), value: JSON.stringify(completed) }],
      });
    } catch (err) {
      s.log.warn("review.completed not published", { error: (err as Error).message });
    }
  },
};

/** "published" only when both the review and the Check Run reached GitHub. */
export function publishStatus(github: { error?: unknown; checkRunError?: unknown }): "published" | "partial" | "failed" {
  if (github.error && github.checkRunError) return "failed";
  return github.error || github.checkRunError ? "partial" : "published";
}

function scopeNotes(s: ReviewRunState): string[] {
  const notes = [`Reviewed ${s.files.length} file(s)${s.incremental ? " changed since the last review" : ""}.`];
  const v = s.verification;
  if (v.status === "verified") {
    notes.push(`Findings checked by an independent pass: ${v.confirmed} confirmed, ${v.uncertain} uncertain (severity lowered), ${v.rejected.length} removed as not supported by the diff.`);
  }
  if (s.duplicatesRemoved > 0) notes.push(`${s.duplicatesRemoved} duplicate finding(s) merged.`);
  if (s.filteredOut.length > 0) notes.push(`${s.filteredOut.length} low-severity or low-confidence finding(s) not shown (see .codeguard.yml min_severity / policy.min_confidence).`);
  if (s.ignoredFiles.length) notes.push(`Ignored by config: ${s.ignoredFiles.length} file(s)`);
  if (s.skills.ids.length) notes.push(`Review skills: ${s.skills.ids.join(", ")}`);
  const failed = s.trace.filter((t) => t.status === "failed");
  if (failed.length) notes.push(`Stages that could not run: ${failed.map((t) => t.name).join(", ")}`);
  return notes;
}

/** What the dashboard and later runs need, trimmed to stay small. */
function resultMetadata(s: ReviewRunState): Record<string, unknown> {
  return {
    pipelineVersion: 2,
    provider: s.llm.provider.name,
    usage: s.llm.usage,
    llmCalls: s.llm.calls,
    durationMs: Date.now() - s.startedAt,
    triggeredBy: s.event.triggeredBy,
    incremental: s.incremental,
    reviewBaseSha: s.reviewBaseSha,
    includedFiles: s.files.map((f) => f.filename).slice(0, 300),
    ignoredFiles: s.ignoredFiles.slice(0, 100),
    verification: s.verification,
    duplicatesRemoved: s.duplicatesRemoved,
    filteredIssueCount: s.filteredOut.length,
    intent: s.intent,
    alignment: s.alignment,
    committer: s.committer,
    volume: s.volume,
    cohesion: { ...s.cohesion, clusters: s.cohesion.clusters.slice(0, 10).map((c) => c.slice(0, 10)) },
    blast: { ...s.blast, dependents: s.blast.dependents.slice(0, 50), hotspots: s.blast.hotspots.slice(0, 10) },
    criticality: s.criticality,
    risk: s.risk,
    testing: s.testing,
    scorecard: s.scorecard,
    policies: s.policies,
    decision: s.decision,
    recommendations: s.insights?.recommendations ?? [],
    technology: { languages: s.tech.languages.slice(0, 6), frameworks: s.tech.frameworks, testFrameworks: s.tech.testFrameworks, monorepo: s.tech.monorepo },
    skills: s.skills.ids,
    changedSymbols: s.changedSymbols.slice(0, 50),
    trace: s.trace,
    progress: { node: "done", at: new Date().toISOString() },
  };
}
