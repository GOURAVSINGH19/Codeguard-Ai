import { TOPICS, prMessageKey } from "@codeguard/kafka";
import type { ReviewCompletedEvent } from "@codeguard/kafka";
import {
  VerificationOutputSchema,
  aggregateFindings,
  applyFindingVerdicts,
  buildContextPacks,
  buildScorecard,
  buildVerifyMessages,
  createCheckRun,
  decideAssurance,
  deduplicateFindings,
  evaluatePolicies,
  filterForReport,
  generateInsights,
  planVerification,
  postReview,
  renderPack,
} from "@codeguard/review-engine";
import type { PipelineStep } from "@codeguard/review-engine";
import { getWorkerProducer } from "../../queue/kafkaClient.js";
import { patchReviewMetadata, saveCompletedReview } from "../store.js";
import type { ReviewRunState } from "../state.js";

type Step = PipelineStep<ReviewRunState>;

export const aggregateFindingsNode: Step = {
  name: "aggregate_findings",
  async run(s) {
    s.aggregated = aggregateFindings(Object.values(s.findingsBySource), new Set(s.allFiles.map((f) => f.filename)));
  },
};

export const deduplicateFindingsNode: Step = {
  name: "deduplicate_findings",
  async run(s) {
    const { findings, removed } = deduplicateFindings(s.aggregated);
    s.deduplicated = findings;
    s.duplicatesRemoved = removed;
  },
};

export const verificationPlanner: Step = {
  name: "verification_planner",
  async run(s) {
    s.plan = planVerification(s.deduplicated, s.config);
  },
};

/**
 * A second model, with no stake in the findings, checks each one against the
 * diff. If it fails, findings are kept unverified (precision drops, the
 * review is not lost).
 */
export const independentVerify: Step = {
  name: "independent_verify",
  async run(s) {
    const plan = s.plan!;
    let checked = plan.verify.map((f) => ({ ...f, verification: "unverified" as const }));
    if (plan.verify.length > 0) {
      try {
        s.packs ??= buildContextPacks({ files: s.files });
        const files = [...new Set(plan.verify.map((f) => f.file).filter((f): f is string => Boolean(f)))];
        const diff = renderPack(s.packs.verify, s.files, files);
        const output = await s.llm.json(buildVerifyMessages({ diff: diff.text, relatedCode: s.packs.verify.relatedCode, issues: plan.verify }), VerificationOutputSchema);
        const result = applyFindingVerdicts(plan.verify, output);
        checked = result.findings.map((f) => ({ ...f, verification: f.verification ?? "unverified" })) as typeof checked;
        s.verification = {
          status: "verified",
          confirmed: result.confirmed,
          uncertain: result.uncertain,
          rejected: result.rejected.map((r) => ({ message: r.message, reason: r.reason })),
        };
      } catch (err) {
        const error = (err as Error).message;
        s.log.warn("verification failed, keeping unverified findings", { error });
        s.verification = { status: "failed", confirmed: 0, uncertain: 0, rejected: [], error: error.slice(0, 300) };
      }
    }
    const { kept, filtered } = filterForReport([...plan.trusted, ...checked, ...plan.unverified], s.config);
    s.findings = kept;
    s.filteredOut = [...plan.dropped, ...filtered];
  },
};

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
      try {
        const posted = await postReview(s.octokit, {
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
        });
        s.published = true;
        s.githubReview = { id: posted.id, url: posted.htmlUrl, mode: posted.mode, inlineCount: posted.inlineCount };
        Object.assign(github, { reviewId: posted.id, url: posted.htmlUrl, mode: posted.mode, inlineCount: posted.inlineCount });
      } catch (err) {
        s.log.error("posting the review to GitHub failed", { error: (err as Error).message });
        github.error = (err as Error).message.slice(0, 300);
      }

      try {
        await createCheckRun(s.octokit, {
          owner,
          repo,
          headSha: s.headSha,
          conclusion: s.decision!.conclusion,
          score: s.scorecard!.overall,
          issues: s.findings,
          failOn: s.config.fail_on,
          title: s.decision!.headline,
          summary: s.insights!.checkSummary,
        });
      } catch (err) {
        s.log.warn("check run not created (needs checks:write permission)", { error: (err as Error).message });
        github.checkRunError = (err as Error).message.slice(0, 300);
      }
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
