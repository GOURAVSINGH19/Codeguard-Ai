import { after } from "next/server";
import { getEnv } from "@codeguard/config";
import { ReviewEngine } from "@codeguard/review-engine";
import { getSharedProducer, prMessageKey, TOPICS } from "@codeguard/kafka";
import type { ReviewRequestedEvent } from "@codeguard/kafka";
import { HttpError } from "@/lib/api";
import { ReviewPersistenceService } from "./ReviewPersistenceService";
import type { GitHubPRDetail } from "./GitHubService";

async function publishReviewRequest(event: ReviewRequestedEvent): Promise<void> {
  // Broker private to the workers: the pending row is picked up by their recovery sweeper.
  if (!getEnv().KAFKA_PUBLISH_FROM_WEB) return;
  const producer = await getSharedProducer();
  await producer.send({
    topic: TOPICS.REVIEW_REQUESTED,
    messages: [{ key: prMessageKey(event.owner, event.repo, event.pullNumber), value: JSON.stringify(event) }],
  });
}

/**
 * ReviewService — starts reviews without holding the HTTP request open.
 *
 * Both routes create a `pending` review row and return 202 immediately; the
 * browser follows progress over SSE (GET /api/reviews/:id/events).
 * - PR reviews are queued to the workers' staged pipeline via Kafka.
 * - Snippet reviews (no repository context) run in `after()`.
 */
export class ReviewService {
  constructor(
    private readonly persistence = new ReviewPersistenceService(),
    private readonly engineFactory: () => ReviewEngine = () => ReviewEngine.fromEnv(),
    private readonly publish: (event: ReviewRequestedEvent) => Promise<void> = publishReviewRequest
  ) {}

  /** Throws 429 when the user started too many reviews in the last hour. */
  async enforceRateLimit(userId: string): Promise<void> {
    const limit = getEnv().REVIEW_RATE_LIMIT_PER_HOUR;
    const used = await this.persistence.countReviewsSince(userId, new Date(Date.now() - 60 * 60_000));
    if (used >= limit) {
      throw new HttpError(429, `Review limit reached (${limit} per hour). Please try again later.`, "rate_limited");
    }
  }

  async startSnippetReview(input: { userId: string; code: string; language: string; title?: string }) {
    const engine = this.engineFactory(); // fail fast (503) if the LLM isn't configured
    await this.enforceRateLimit(input.userId);
    const pending = await this.persistence.createPendingSnippetReview(input);

    after(async () => {
      try {
        const run = await engine.reviewSnippet(input.code, input.language);
        await this.persistence.completeReview(pending.id, run, { kind: "snippet" });
      } catch (err) {
        console.error(`[ReviewService] snippet review ${pending.id} failed:`, err);
        await this.persistence.failReview(pending.id, err).catch(() => {});
      }
    });

    return { id: pending.id, status: "pending" as const, createdAt: pending.createdAt };
  }

  /**
   * PR reviews run in the workers' staged pipeline — the same one webhooks
   * use (repo snapshot, graph, intent, three validation stages, verification,
   * policy) — instead of a reduced engine call inside this request.
   *
   * If Kafka is unreachable the pending row stays queued and the workers'
   * recovery sweeper publishes it, so the request still succeeds.
   */
  async startPRReview(userId: string, pr: GitHubPRDetail) {
    const repo = await this.persistence.ensureRepository(pr);
    const prRecord = await this.persistence.ensurePullRequest(pr, repo.id);

    // Idempotent: same user + same commit → the existing review, no new LLM call.
    const existing = await this.persistence.findActivePRReview(userId, prRecord.id, pr.headSha);
    if (existing) return { id: existing.id, status: existing.status, reused: true };

    // Check the limit BEFORE creating a row, so a rejected attempt costs nothing.
    await this.enforceRateLimit(userId);

    const created = await this.persistence.createPendingPRReview(userId, prRecord.id, pr);
    if (!created) {
      const raced = await this.persistence.findActivePRReview(userId, prRecord.id, pr.headSha);
      if (!raced) throw new HttpError(409, "A review for this commit is already being created. Please retry.");
      return { id: raced.id, status: raced.status, reused: true };
    }

    const [owner, name] = pr.repoFullName.split("/");
    const event: ReviewRequestedEvent = {
      owner,
      repo: name,
      pullNumber: pr.number,
      userId,
      triggeredBy: "manual",
      headSha: pr.headSha,
      reviewId: created.id,
      // Dashboard reviews stay in the dashboard; posting is a separate action.
      publishToGitHub: false,
      requestedAt: new Date().toISOString(),
    };
    try {
      await this.publish(event);
    } catch (err) {
      console.warn(`[ReviewService] review ${created.id} queued for retry (Kafka publish failed):`, (err as Error).message);
      await this.persistence.mergeMetadata(created.id, { queued: "kafka publish failed — retried by the recovery sweeper" }).catch(() => {});
    }
    return { id: created.id, status: "pending", reused: false };
  }
}
