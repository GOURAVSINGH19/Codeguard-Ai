import { runPipeline } from "@codeguard/review-engine";
import type { PipelineNode } from "@codeguard/review-engine";
import type { ReviewRequestedEvent } from "@codeguard/kafka";
import { logger } from "../lib/logger.js";
import {
  buildContextPacksNode,
  buildSoftwareGraph,
  collectBusinessContext,
  collectPrContext,
  detectTechnologyNode,
  extractBusinessIntent,
  initializeRun,
  resolveSkillsNode,
  snapshotRepository,
  validateEvent,
} from "./nodes/prepare.js";
import { stage1, stage2, stage3 } from "./nodes/stages.js";
import {
  aggregateFindingsNode,
  assuranceDecision,
  deduplicateFindingsNode,
  generateInsightsNode,
  independentVerify,
  policyEvaluation,
  publishReport,
  scorecardNode,
  verificationPlanner,
} from "./nodes/finalize.js";
import { failReview, patchReviewMetadata } from "./store.js";
import { initialState } from "./state.js";
import type { ReviewRunState } from "./state.js";

/**
 * The review workflow, in order:
 *
 *   initialize_run → validate_event → snapshot_repository → collect_pr_context
 *   → collect_business_context → detect_technology → resolve_skills
 *   → build_context_packs → build_software_graph → extract_business_intent
 *   → STAGE 1 (committer ∥ align ∥ volume ∥ cohesion)
 *   → STAGE 2 (blast_radius ∥ criticality) → risk_assessment
 *   → STAGE 3 (quality ∥ security ∥ testing)
 *   → aggregate_findings → deduplicate_findings → verification_planner
 *   → independent_verify → scorecard → policy_evaluation → assurance_decision
 *   → generate_insights → publish_report
 *
 * Optional nodes (context, intent, graph, model reviewers) degrade the review
 * when they fail; required nodes fail the run, which is retried by Kafka.
 */
export const REVIEW_WORKFLOW: PipelineNode<ReviewRunState>[] = [
  initializeRun,
  validateEvent,
  snapshotRepository,
  collectPrContext,
  collectBusinessContext,
  detectTechnologyNode,
  resolveSkillsNode,
  buildContextPacksNode,
  buildSoftwareGraph,
  extractBusinessIntent,
  stage1,
  stage2,
  stage3,
  aggregateFindingsNode,
  deduplicateFindingsNode,
  verificationPlanner,
  independentVerify,
  scorecardNode,
  policyEvaluation,
  assuranceDecision,
  generateInsightsNode,
  publishReport,
];

export async function runReviewPipeline(event: ReviewRequestedEvent): Promise<ReviewRunState> {
  const log = logger.child({ pr: `${event.owner}/${event.repo}#${event.pullNumber}`, deliveryId: event.deliveryId, trigger: event.triggeredBy });
  const state = initialState(event, log);

  try {
    await runPipeline(REVIEW_WORKFLOW, state, {
      stopReason: () => state.stop,
      // Progress for the dashboard (SSE) and the liveness heartbeat for stale-run recovery.
      onNodeStart: async (node) => {
        if (state.reviewId) await patchReviewMetadata(state.reviewId, { progress: { node, at: new Date().toISOString() } }).catch(() => {});
      },
      onNodeEnd: (trace) => {
        state.trace.push(trace);
        if (trace.status === "failed") log.warn("pipeline node failed", { node: trace.name, error: trace.error });
      },
    });
  } catch (err) {
    // publish_report saves the review as completed before touching GitHub, so
    // a failure here always means nothing was posted and a retry is safe.
    if (state.reviewId && !state.published) {
      await failReview(state.reviewId, (err as Error).message, { trace: state.trace }).catch(() => {});
    }
    throw err;
  }

  if (state.stop) {
    log.info("review skipped", { reason: state.stop });
  } else {
    log.info("review completed", {
      score: state.scorecard?.overall,
      decision: state.decision?.verdict,
      risk: state.risk?.level,
      findings: state.findings.length,
      inline: state.githubReview?.inlineCount,
      tokens: state.llm.usage?.totalTokens,
      llmCalls: state.llm.calls,
      durationMs: Date.now() - state.startedAt,
    });
  }
  return state;
}
