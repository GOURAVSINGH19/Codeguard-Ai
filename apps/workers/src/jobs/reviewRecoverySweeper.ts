import { db, reviews, pullRequests, repositories, eq, and, or, lt, gt, isNull, isNotNull, inArray, sql } from "@codeguard/db";
import { TOPICS, prMessageKey } from "@codeguard/kafka";
import type { ReviewRequestedEvent } from "@codeguard/kafka";
import { getWorkerProducer } from "../queue/kafkaClient.js";
import { STALE_REVIEW_MS } from "../pipeline/store.js";
import { logger } from "../lib/logger.js";

/**
 * Review recovery — nothing stays "in progress" forever.
 *
 * 1. `in_progress` rows not touched for STALE_REVIEW_MS (worker crashed or was
 *    redeployed mid-run) go back to `pending`, at most MAX_RECOVERIES times,
 *    then `failed`.
 * 2. `pending` PR reviews older than PENDING_GRACE_MS are (re)published to
 *    review.requested. This covers dashboard requests whose Kafka publish
 *    failed and rows recovered in step 1. Duplicate messages are harmless:
 *    the worker only takes a row that is still pending.
 * 3. Snippet reviews (run inside the web app) stuck for STALE_REVIEW_MS and
 *    anything pending for a day are failed, so the UI stops waiting.
 */
const INTERVAL_MS = Number(process.env.REVIEW_RECOVERY_INTERVAL_MS) || 60_000;
/**
 * How long a new pending row waits for the web app's own publish before the
 * sweeper sends it. 0 when the web app never publishes (KAFKA_PUBLISH_FROM_WEB=false).
 */
const PENDING_GRACE_MS =
  process.env.REVIEW_PENDING_GRACE_MS !== undefined && process.env.REVIEW_PENDING_GRACE_MS !== "" ? Number(process.env.REVIEW_PENDING_GRACE_MS) : 2 * 60_000;
/** A queued row still pending after this is sent again (the first message may have been lost). */
const RESEND_MS = 2 * 60_000;
const MAX_AGE_MS = 24 * 60 * 60_000;
const MAX_RECOVERIES = 3;
const BATCH = 25;

let timer: NodeJS.Timeout | null = null;

export async function sweepReviews(now = Date.now()): Promise<{ recovered: number; republished: number; failed: number }> {
  const stale = new Date(now - STALE_REVIEW_MS);
  const recoveries = sql<number>`coalesce((${reviews.metadata}->>'recoveries')::int, 0)`;

  // 1a. Too many recoveries → failed.
  const exhausted = await db
    .update(reviews)
    .set({
      status: "failed",
      updatedAt: new Date(now),
      metadata: sql`coalesce(${reviews.metadata}, '{}'::jsonb) || '{"error":"abandoned after repeated recoveries","userMessage":"The review stopped responding several times and was abandoned. Please try again."}'::jsonb`,
    })
    .where(and(eq(reviews.status, "in_progress"), lt(reviews.updatedAt, stale), sql`${recoveries} >= ${MAX_RECOVERIES}`))
    .returning({ id: reviews.id });

  // 1b. Stale PR reviews → pending (republished by step 2).
  const recovered = await db
    .update(reviews)
    .set({
      status: "pending",
      updatedAt: new Date(now - PENDING_GRACE_MS - 1_000), // picked up by step 2 in this tick
      // Dropping queuedAt makes step 2 send it right away.
      metadata: sql`(coalesce(${reviews.metadata}, '{}'::jsonb) - 'queuedAt') || jsonb_build_object('recoveries', ${recoveries} + 1)`,
    })
    .where(and(eq(reviews.status, "in_progress"), lt(reviews.updatedAt, stale), isNotNull(reviews.pullRequestId)))
    .returning({ id: reviews.id });

  // 3. Snippet reviews stuck in the web app, and anything pending for a day.
  const abandoned = await db
    .update(reviews)
    .set({
      status: "failed",
      updatedAt: new Date(now),
      metadata: sql`coalesce(${reviews.metadata}, '{}'::jsonb) || '{"error":"timed out","userMessage":"The review did not finish in time. Please try again."}'::jsonb`,
    })
    .where(
      or(
        and(isNull(reviews.pullRequestId), inArray(reviews.status, ["pending", "in_progress"]), lt(reviews.updatedAt, stale)),
        and(eq(reviews.status, "pending"), lt(reviews.createdAt, new Date(now - MAX_AGE_MS)))
      )
    )
    .returning({ id: reviews.id });

  // 2. Publish pending PR reviews that nobody has picked up.
  const pending = await db
    .select({
      id: reviews.id,
      userId: reviews.userId,
      headSha: reviews.headSha,
      prNumber: pullRequests.prNumber,
      owner: repositories.owner,
      name: repositories.name,
    })
    .from(reviews)
    .innerJoin(pullRequests, eq(reviews.pullRequestId, pullRequests.id))
    .innerJoin(repositories, eq(pullRequests.repositoryId, repositories.id))
    .where(
      and(
        eq(reviews.status, "pending"),
        gt(reviews.createdAt, new Date(now - MAX_AGE_MS)),
        or(
          // never sent by us: wait out the web app's own publish
          and(sql`${reviews.metadata}->>'queuedAt' IS NULL`, lt(reviews.updatedAt, new Date(now - PENDING_GRACE_MS))),
          // sent, but nobody took it: send again
          sql`(${reviews.metadata}->>'queuedAt')::timestamptz < ${new Date(now - RESEND_MS).toISOString()}::timestamptz`
        )
      )
    )
    .orderBy(reviews.createdAt)
    .limit(BATCH);

  if (pending.length > 0) {
    const producer = await getWorkerProducer();
    for (const row of pending) {
      const event: ReviewRequestedEvent = {
        owner: row.owner,
        repo: row.name,
        pullNumber: row.prNumber,
        userId: row.userId,
        triggeredBy: row.userId ? "manual" : "webhook",
        headSha: row.headSha ?? undefined,
        reviewId: row.id,
        publishToGitHub: row.userId === null,
        requestedAt: new Date(now).toISOString(),
      };
      await producer.send({ topic: TOPICS.REVIEW_REQUESTED, messages: [{ key: prMessageKey(row.owner, row.name, row.prNumber), value: JSON.stringify(event) }] });
      // Remember when it was sent, so the next ticks don't send it again.
      await db
        .update(reviews)
        .set({ metadata: sql`coalesce(${reviews.metadata}, '{}'::jsonb) || ${JSON.stringify({ queuedAt: new Date(now).toISOString() })}::jsonb` })
        .where(and(eq(reviews.id, row.id), eq(reviews.status, "pending")));
    }
  }
  return { recovered: recovered.length, republished: pending.length, failed: exhausted.length + abandoned.length };
}

export function startReviewRecoverySweeper(): void {
  const log = logger.child({ job: "reviewRecoverySweeper" });
  let running = false;
  const tick = async () => {
    if (running) return; // a slow sweep must not overlap the next one
    running = true;
    try {
      const result = await sweepReviews();
      if (result.recovered || result.republished || result.failed) log.info("review recovery", result);
    } catch (err) {
      log.warn("review recovery sweep failed", { error: (err as Error).message });
    } finally {
      running = false;
    }
  };
  timer = setInterval(tick, INTERVAL_MS);
  void tick();
}

export function stopReviewRecoverySweeper(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
