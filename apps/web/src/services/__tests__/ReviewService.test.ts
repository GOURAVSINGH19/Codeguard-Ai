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
  return {
    countReviewsSince: vi.fn(async () => opts.recent ?? 0),
    ensureRepository: vi.fn(async () => ({ id: "repo" })),
    ensurePullRequest: vi.fn(async () => ({ id: "pr" })),
    claimPRReview: vi.fn(async (userId: string, prId: string, p: { headSha: string }) => {
      const key = `${userId}:${prId}:${p.headSha}`;
      const existing = claims.get(key);
      if (existing) return { review: existing, created: false as const };
      const review = { id: `review-${claims.size + 1}`, status: "pending", createdAt: new Date() };
      claims.set(key, review);
      return { review, created: true as const };
    }),
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
  it("reviews the same commit only once, even if requested twice", async () => {
    const persistence = makePersistence();
    const engine = makeEngine();
    const service = new ReviewService(persistence as never, () => engine as never);

    const first = await service.startPRReview("user_1", pr);
    const second = await service.startPRReview("user_1", pr);
    await Promise.all(scheduled.map((fn) => fn()));

    expect(second).toMatchObject({ id: first.id, reused: true });
    expect(engine.reviewPullRequest).toHaveBeenCalledTimes(1);
    expect(persistence.completeReview).toHaveBeenCalledTimes(1);
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
