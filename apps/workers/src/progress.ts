import { db, reviews, eq, type NewReview } from "@codeguard/db";

/**
 * Move a review to the next pipeline node.
 * `progress` names must match the labels in apps/web/src/lib/poll-review.ts.
 * Every call also bumps updated_at: that is the heartbeat the Day 3
 * stuck-review sweeper uses to tell "slow" from "dead".
 */
export type ProgressNode =
  | "initialize_run"
  | "collect_pr_context"
  | "build_context_packs"
  | "quality"
  | "aggregate_findings"
  | "publish_report"
  | "done";

export async function setProgress(reviewId: string, node: ProgressNode, extra: Partial<NewReview> = {}): Promise<void> {
  await db
    .update(reviews)
    .set({ ...extra, progress: node, updatedAt: new Date() })
    .where(eq(reviews.id, reviewId));
}
