/**
 * Browser helper: wait for an asynchronously running review to finish.
 * POST /api/review and /api/github/review return 202 + id; this polls
 * GET /api/reviews/:id with gentle backoff until completed or failed.
 */
export interface PolledReview {
  id: string;
  status: string;
  score: number | null;
  summary: string | null;
  issues: Array<{
    severity: "critical" | "high" | "medium" | "low";
    category: "security" | "bug" | "performance" | "maintainability" | "style";
    file: string | null;
    line: number | null;
    message: string;
    suggestion: string | null;
  }>;
  createdAt: string;
  details?: { githubUrl: string | null } | null;
}

export async function pollReview(id: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<PolledReview> {
  const deadline = Date.now() + (opts.timeoutMs ?? 5 * 60_000);
  let delay = 1_000;

  while (Date.now() < deadline) {
    if (opts.signal?.aborted) throw new Error("Cancelled");
    const res = await fetch(`/api/reviews/${id}`, { cache: "no-store", signal: opts.signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Could not load the review");

    const review = data.review as PolledReview;
    if (review.status === "completed") return review;
    if (review.status === "failed") throw new Error("The review failed. Please try again.");

    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 5_000);
  }
  throw new Error("The review is taking longer than expected. Check your review history in a minute.");
}
