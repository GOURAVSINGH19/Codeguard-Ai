import { describe, it, expect, vi, beforeEach } from "vitest";

// Run `after()` callbacks synchronously-on-demand in tests.
const scheduled: Array<() => Promise<void>> = [];
vi.mock("next/server", () => ({ after: (fn: () => Promise<void>) => scheduled.push(fn) }));
vi.mock("@codeguard/db", () => ({}));

const { ReviewService } = await import("../ReviewService");
const { resetEnvCache } = await import("@codeguard/config");
const { HttpError } = await import("@/lib/api");

const pr = {
  id: 1, number: 7, title: "Add x", body: null, state: "open", headSha: "abc1234", baseSha: "def5678",
  repoId: 9, repoFullName: "acme/api", repoDefaultBranch: "main", repoIsPrivate: false, repoLanguage: "TypeScript",
  repoCloneUrl: null, repoHtmlUrl: null, additions: 1, deletions: 0, changedFiles: 1,
  files: [], patches: [{ filename: "a.ts", status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1 @@\n+x" }],
} as never;

function makePersistence(opts: { recent?: number } = {}) {
  const claims = new Map<string, { id: string; status: string; createdAt: Date }>();
  const key = (userId: string, prId: string, sha: string) => `${userId}:${prId}:${sha}`;
  return {
    countReviewsSince: vi.fn(async () => opts.recent ?? 0),
    ensureRepository: vi.fn(async () => ({ id: "repo" })),
    ensurePullRequest: vi.fn(async () => ({ id: "pr" })),
    findActivePRReview: vi.fn(async (userId: string, prId: string, headSha: string) => claims.get(key(userId, prId, headSha)) ?? null),
    createPendingPRReview: vi.fn(async (userId: string, prId: string, p: { headSha: string }) => {
      const k = key(userId, prId, p.headSha);
      if (claims.has(k)) return null;
      const review = { id: `review-${claims.size + 1}`, status: "pending", createdAt: new Date() };
      claims.set(k, review);
      return review;
    }),
    mergeMetadata: vi.fn(async () => {}),
    completeReview: vi.fn(async () => {}),
    failReview: vi.fn(async () => {}),
    createPendingSnippetReview: vi.fn(async () => ({ id: "snippet-1", createdAt: new Date() })),
  };
}

function makeEngine() {
  return {
    reviewPullRequest: vi.fn(async () => ({ score: 8, summary: "ok", issues: [], includedFiles: ["a.ts"], excludedFiles: [], ignoredFiles: [] })),
    reviewSnippet: vi.fn(async () => ({ score: 8, summary: "ok", issues: [] })),
  };
}

beforeEach(() => {
  scheduled.length = 0;
  process.env.REVIEW_RATE_LIMIT_PER_HOUR = "5";
  resetEnvCache();
});

describe("ReviewService", () => {
  it("queues the same commit only once, even if requested twice", async () => {
    const persistence = makePersistence();
    const publish = vi.fn(async () => {});
    const service = new ReviewService(persistence as never, () => makeEngine() as never, publish);

    const first = await service.startPRReview("user_1", pr);
    const second = await service.startPRReview("user_1", pr);

    expect(second).toMatchObject({ id: first.id, reused: true });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "acme", repo: "api", pullNumber: 7, reviewId: first.id, triggeredBy: "manual", headSha: "abc1234", publishToGitHub: false })
    );
    expect(scheduled).toHaveLength(0); // PR reviews no longer run inside the web request
  });

  it("keeps the review queued when Kafka is down (the recovery sweeper publishes it)", async () => {
    const persistence = makePersistence();
    const publish = vi.fn(async () => {
      throw new Error("broker unreachable");
    });
    const started = await new ReviewService(persistence as never, () => makeEngine() as never, publish).startPRReview("user_1", pr);
    expect(started).toMatchObject({ status: "pending", reused: false });
    expect(persistence.mergeMetadata).toHaveBeenCalledWith(started.id, expect.objectContaining({ queued: expect.any(String) }));
  });

  it("checks the rate limit before creating a PR review row", async () => {
    const persistence = makePersistence({ recent: 5 });
    const publish = vi.fn(async () => {});
    const err = await new ReviewService(persistence as never, () => makeEngine() as never, publish).startPRReview("user_1", pr).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(429);
    expect(persistence.createPendingPRReview).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("returns 202-style pending state and finishes in the background", async () => {
    const persistence = makePersistence();
    const service = new ReviewService(persistence as never, () => makeEngine() as never);
    const started = await service.startSnippetReview({ userId: "u", code: "x", language: "ts" });
    expect(started.status).toBe("pending");
    expect(persistence.completeReview).not.toHaveBeenCalled();
    await scheduled[0]();
    expect(persistence.completeReview).toHaveBeenCalledWith("snippet-1", expect.anything(), { kind: "snippet" });
  });

  it("marks the review failed when the model call fails", async () => {
    const persistence = makePersistence();
    const engine = makeEngine();
    engine.reviewSnippet.mockRejectedValueOnce(new Error("LLM down"));
    await new ReviewService(persistence as never, () => engine as never).startSnippetReview({ userId: "u", code: "x", language: "ts" });
    await scheduled[0]();
    expect(persistence.failReview).toHaveBeenCalledWith("snippet-1", expect.any(Error));
  });

  it("rate-limits users who start too many reviews", async () => {
    const persistence = makePersistence({ recent: 5 });
    const service = new ReviewService(persistence as never, () => makeEngine() as never);
    const err = await service.startSnippetReview({ userId: "u", code: "x", language: "ts" }).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(429);
    expect(persistence.createPendingSnippetReview).not.toHaveBeenCalled();
  });
});
