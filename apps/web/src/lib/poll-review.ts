/**
 * Browser helper: wait for an asynchronously running review to finish.
 *
 * POST /api/review and /api/github/review return 202 + id. This follows
 * GET /api/reviews/:id/events (Server-Sent Events) and reports each pipeline
 * stage through `onProgress`; if SSE is unavailable it falls back to polling
 * GET /api/reviews/:id. Either way it resolves with the full review.
 */
export interface PolledReview {
  id: string;
  status: string;
  score: number | null;
  summary: string | null;
  issues: Array<{
    id?: string;
    severity: "critical" | "high" | "medium" | "low";
    category: "security" | "bug" | "performance" | "maintainability" | "style";
    file: string | null;
    line: number | null;
    message: string;
    suggestion: string | null;
    status?: string;
    source?: string | null;
    confidence?: number | null;
  }>;
  createdAt: string;
  details?: { githubUrl: string | null } | null;
  error?: string | null;
}

export interface WaitOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called with the pipeline node currently running, e.g. "security". */
  onProgress?: (node: string | null, status: string) => void;
}

/** Human label for a pipeline node. */
export function progressLabel(node: string | null): string {
  if (!node) return "Queued";
  const labels: Record<string, string> = {
    initialize_run: "Starting",
    validate_event: "Starting",
    snapshot_repository: "Reading the repository",
    collect_pr_context: "Collecting the pull request",
    collect_business_context: "Reading linked issues",
    detect_technology: "Detecting the stack",
    resolve_skills: "Choosing review checklists",
    build_context_packs: "Gathering related code",
    build_software_graph: "Mapping dependencies",
    extract_business_intent: "Understanding the intent",
    committer: "Understanding the change",
    align: "Checking it matches the description",
    volume: "Understanding the change",
    cohesion: "Understanding the change",
    blast_radius: "Measuring the blast radius",
    criticality: "Assessing risk",
    risk_assessment: "Assessing risk",
    quality: "Reviewing code quality",
    security: "Reviewing security",
    testing: "Checking tests",
    aggregate_findings: "Merging findings",
    deduplicate_findings: "Merging findings",
    verification_planner: "Verifying findings",
    independent_verify: "Verifying findings",
    scorecard: "Scoring",
    policy_evaluation: "Applying policies",
    assurance_decision: "Deciding",
    generate_insights: "Writing the report",
    publish_report: "Publishing",
    done: "Done",
  };
  return labels[node] ?? "Reviewing";
}

export async function pollReview(id: string, opts: WaitOptions = {}): Promise<PolledReview> {
  const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000);
  if (typeof EventSource !== "undefined") {
    try {
      await followEvents(id, deadline, opts);
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      // SSE blocked (proxy, old browser): fall through to polling.
    }
  }
  return pollUntilDone(id, deadline, opts);
}

/** Resolves when the stream reports done; rejects if the stream is unusable. */
function followEvents(id: string, deadline: number, opts: WaitOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const source = new EventSource(`/api/reviews/${id}/events`);
    let opened = false;
    let failures = 0;
    const finish = (fn: () => void) => {
      source.close();
      clearInterval(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => finish(() => reject(new Error("Cancelled")));
    opts.signal?.addEventListener("abort", onAbort);
    const timer = setInterval(() => {
      if (Date.now() > deadline) finish(() => resolve());
    }, 5_000);

    source.addEventListener("open", () => {
      opened = true;
      failures = 0;
    });
    source.addEventListener("progress", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as { status: string; progress: string | null };
      opts.onProgress?.(data.progress, data.status);
    });
    source.addEventListener("done", () => finish(() => resolve()));
    source.onerror = () => {
      // EventSource reconnects by itself after a server-closed stream; give up
      // only if it never connected or keeps failing.
      failures++;
      if (!opened || failures >= 3) finish(() => reject(new Error("event stream unavailable")));
    };
  });
}

async function pollUntilDone(id: string, deadline: number, opts: WaitOptions): Promise<PolledReview> {
  let delay = 1_000;
  while (true) {
    if (opts.signal?.aborted) throw new Error("Cancelled");
    const res = await fetch(`/api/reviews/${id}`, { cache: "no-store", signal: opts.signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Could not load the review");

    const review = data.review as PolledReview & { progress?: string | null };
    if (review.status === "completed") return review;
    if (review.status === "failed") throw new Error(review.error || "The review failed. Please try again.");
    opts.onProgress?.(review.progress ?? null, review.status);

    if (Date.now() > deadline) throw new Error("The review is taking longer than expected. Check your review history in a minute.");
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 5_000);
  }
}
