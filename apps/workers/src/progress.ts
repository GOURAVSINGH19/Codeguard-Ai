import { db, reviews, eq, type NewReview } from "@codeguard/db";

/**
 * Move a review to the next pipeline node.
 * Node names must match the labels in apps/web/src/lib/poll-review.ts
 * (initialize_run, collect_pr_context, build_context_packs, build_software_graph,
 * committer, blast_radius, risk_assessment, quality, aggregate_findings,
 * deduplicate_findings, independent_verify, scorecard, policy_evaluation,
 * assurance_decision, publish_report, done).
 *
 * Every call also bumps updated_at: the heartbeat the stuck-review sweeper uses
 * to tell "slow" from "dead".
 */
export async function setProgress(reviewId: string, node: string, extra: Partial<NewReview> = {}): Promise<void> {
  await db
    .update(reviews)
    .set({ ...extra, progress: node, updatedAt: new Date() })
    .where(eq(reviews.id, reviewId));
}
