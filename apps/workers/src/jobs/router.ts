import { db, webhookEvents, repositories, githubInstallations, eq } from "@codeguard/db";
import { publish, prKey, TOPICS, ReviewRequested, type WebhookReceived } from "@codeguard/kafka";

/**
 * The ROUTER: turns "GitHub said something happened" into "this commit needs a review".
 * Cheap decisions only. No AI and no GitHub API calls here.
 */

const REVIEW_ACTIONS = new Set(["opened", "synchronize", "reopened", "ready_for_review"]);

interface PullRequestPayload {
  action?: string;
  number?: number;
  installation?: { id: number };
  repository?: { id: number; full_name: string };
  pull_request?: { draft?: boolean; state?: string; head?: { sha?: string } };
}

export type RouteDecision =
  | { review: true; installationId: number; githubRepoId: number; prNumber: number; headSha: string }
  | { review: false; reason: string };

/** Pure: does this event ask for a review at all? (Repo settings are checked separately.) */
export function decideFromPayload(eventType: string, p: PullRequestPayload): RouteDecision {
  if (eventType !== "pull_request") return { review: false, reason: `event ${eventType}` };
  if (!REVIEW_ACTIONS.has(p.action ?? "")) return { review: false, reason: `action ${p.action}` };
  const pr = p.pull_request;
  if (!pr || !p.repository || !p.installation || !p.number || !pr.head?.sha) return { review: false, reason: "incomplete payload" };
  if (pr.draft) return { review: false, reason: "draft PR" };
  if (pr.state !== "open") return { review: false, reason: "PR not open" };
  return {
    review: true,
    installationId: p.installation.id,
    githubRepoId: p.repository.id,
    prNumber: p.number,
    headSha: pr.head.sha,
  };
}

export async function onWebhookReceived(e: WebhookReceived): Promise<void> {
  if (e.eventType !== "pull_request") return; // most events need no work; skip without a DB read

  // The message is a pointer; the payload lives in Postgres (the outbox row).
  const [row] = await db.select().from(webhookEvents).where(eq(webhookEvents.id, e.webhookEventId)).limit(1);
  if (!row) throw new Error(`webhook_events row ${e.webhookEventId} not found`);

  const decision = decideFromPayload(row.eventType, row.payload as PullRequestPayload);
  if (!decision.review) return;

  const [repo] = await db.select().from(repositories).where(eq(repositories.githubRepoId, decision.githubRepoId)).limit(1);
  if (!repo?.active) return console.info(`[router] skip ${e.deliveryId}: repo not granted`);
  if (!repo.autoReviewEnabled) return console.info(`[router] skip ${repo.fullName}#${decision.prNumber}: auto-review off`);

  const [inst] = await db
    .select({ status: githubInstallations.status })
    .from(githubInstallations)
    .where(eq(githubInstallations.installationId, decision.installationId))
    .limit(1);
  if (inst && inst.status !== "active") return console.info(`[router] skip: installation ${inst.status}`);

  await publish(TOPICS.reviewRequested, prKey(repo.fullName, decision.prNumber), ReviewRequested, {
    type: "review.requested",
    installationId: decision.installationId,
    repoFullName: repo.fullName,
    prNumber: decision.prNumber,
    headSha: decision.headSha,
    trigger: "webhook",
    requestedBy: null,
  });
  console.info(`[router] review requested: ${repo.fullName}#${decision.prNumber} @ ${decision.headSha.slice(0, 7)}`);
}
