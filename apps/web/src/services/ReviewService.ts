import { after } from "next/server";
import { getEnv } from "@codeguard/config";
import { ReviewEngine } from "@codeguard/review-engine";
import { HttpError } from "@/lib/api";
import { ReviewPersistenceService } from "./ReviewPersistenceService";
import type { GitHubPRDetail } from "./GitHubService";

/**
 * ReviewService — starts reviews without holding the HTTP request open.
 *
 * The route creates a `pending` review row and returns 202 immediately; the
 * LLM call runs in `after()` (Vercel keeps the function alive until it
 * finishes) and the browser polls GET /api/reviews/:id. A slow model can no
 * longer time out the request, and a failure is recorded on the row.
 */
export class ReviewService {
  constructor(
    private readonly persistence = new ReviewPersistenceService(),
    private readonly engineFactory: () => ReviewEngine = () => ReviewEngine.fromEnv()
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

  async startPRReview(userId: string, pr: GitHubPRDetail) {
    const engine = this.engineFactory();
    const repo = await this.persistence.ensureRepository(pr);
    const prRecord = await this.persistence.ensurePullRequest(pr, repo.id);

    // Idempotent: same user + same commit → the existing review, no new LLM call.
    const claim = await this.persistence.claimPRReview(userId, prRecord.id, pr);
    if (!claim.created) {
      if (!claim.review) throw new HttpError(409, "A review for this commit is already being created. Please retry.");
      return { id: claim.review.id, status: claim.review.status, reused: true };
    }

    // Count only new work against the limit; roll back the claim if over it.
    try {
      await this.enforceRateLimit(userId);
    } catch (err) {
      await this.persistence.failReview(claim.review.id, "rate limited");
      throw err;
    }

    const reviewId = claim.review.id;
    after(async () => {
      try {
        const run = await engine.reviewPullRequest({ title: pr.title, body: pr.body, files: pr.patches });
        await this.persistence.completeReview(reviewId, run, {
          kind: "pr",
          metadata: {
            includedFiles: run.includedFiles,
            excludedFiles: run.excludedFiles,
            ignoredFiles: run.ignoredFiles,
          },
        });
      } catch (err) {
        console.error(`[ReviewService] PR review ${reviewId} failed:`, err);
        await this.persistence.failReview(reviewId, err).catch(() => {});
      }
    });

    return { id: reviewId, status: "pending", reused: false };
  }
}
