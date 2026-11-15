import { db, webhookEvents, reviews, inArray, eq, sql } from "@codeguard/db";
import { publish, prKey, TOPICS, ReviewRequested, WebhookReceived } from "@codeguard/kafka";

/**
 * Sweepers: small loops that repair what crashes leave behind (Day 3.4).
 *
 *   outbox        webhook rows still "received" after 30 s (Kafka was down, or the
 *                 web app died between save and publish) → publish them now
 *   stuck reviews reviews whose heartbeat (updated_at) stopped for 10 min
 *                 (worker killed mid-review) → re-queue, max 3 attempts, then fail
 *
 * FOR UPDATE SKIP LOCKED lets several worker processes sweep at the same time
 * without ever grabbing the same rows.
 */

const OUTBOX_AGE = "30 seconds";
const STUCK_AFTER = "10 minutes";
const MAX_ATTEMPTS = 3;

export async function sweepOutbox(limit = 50): Promise<number> {
  return db.transaction(async (tx) => {
    const { rows } = await tx.execute<{ id: string; delivery_id: string; event_type: string; action: string | null }>(sql`
      SELECT id, delivery_id, event_type, action FROM ${webhookEvents}
      WHERE status = 'received' AND received_at < now() - ${sql.raw(`interval '${OUTBOX_AGE}'`)}
      ORDER BY received_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED`);
    const published: string[] = [];
    for (const r of rows) {
      try {
        await publish(TOPICS.webhookReceived, r.delivery_id, WebhookReceived, {
          type: "webhook.received", webhookEventId: r.id, deliveryId: r.delivery_id, eventType: r.event_type, action: r.action,
        });
        published.push(r.id);
      } catch (err) {
        await tx.update(webhookEvents).set({ error: `sweeper: ${(err as Error).message}`.slice(0, 500) }).where(eq(webhookEvents.id, r.id));
        break; // Kafka is still down; try again next round
      }
    }
    if (published.length) {
      await tx.update(webhookEvents).set({ status: "published", publishedAt: new Date() }).where(inArray(webhookEvents.id, published));
    }
    return published.length;
  });
}

export async function sweepStuckReviews(): Promise<{ requeued: number; failed: number }> {
  // Give up on reviews that already used all their attempts.
  const failed = await db.execute(sql`
    UPDATE ${reviews} SET status = 'failed', progress = NULL, updated_at = now(),
      error = ${`Timed out after ${MAX_ATTEMPTS} attempts`}
    WHERE status IN ('pending', 'in_progress') AND updated_at < now() - ${sql.raw(`interval '${STUCK_AFTER}'`)}
      AND attempts >= ${MAX_ATTEMPTS}`);

  // Reset the others to 'pending' (the claim accepts pending rows) and re-queue them.
  const { rows } = await db.execute<{ id: string; repo_full_name: string; pr_number: number; head_sha: string; installation_id: string | number | null; trigger: "webhook" | "manual" }>(sql`
    UPDATE ${reviews} SET status = 'pending', progress = NULL, attempts = attempts + 1, updated_at = now()
    WHERE id IN (
      SELECT id FROM ${reviews}
      WHERE status IN ('pending', 'in_progress') AND updated_at < now() - ${sql.raw(`interval '${STUCK_AFTER}'`)}
        AND attempts < ${MAX_ATTEMPTS} AND installation_id IS NOT NULL
      LIMIT 20
      FOR UPDATE SKIP LOCKED)
    RETURNING id, repo_full_name, pr_number, head_sha, installation_id, trigger`);

  let requeued = 0;
  for (const r of rows) {
    try {
      await publish(TOPICS.reviewRequested, prKey(r.repo_full_name, r.pr_number), ReviewRequested, {
        type: "review.requested", installationId: Number(r.installation_id), repoFullName: r.repo_full_name,
        prNumber: r.pr_number, headSha: r.head_sha, trigger: r.trigger, requestedBy: null,
      });
      requeued++;
    } catch (err) {
      console.warn(`[sweeper] could not re-queue review ${r.id}:`, (err as Error).message); // next round retries it
    }
  }
  return { requeued, failed: failed.rowCount ?? 0 };
}

/** Run `fn` every `everyMs` (with jitter so several processes don't sweep in lockstep), never overlapping itself. */
export function every(name: string, everyMs: number, fn: () => Promise<unknown>): () => void {
  let running = false;
  let timer: NodeJS.Timeout;
  const tick = async () => {
    if (!running) {
      running = true;
      try {
        await fn();
      } catch (err) {
        console.warn(`[sweeper] ${name} failed:`, (err as Error).message);
      } finally {
        running = false;
      }
    }
    timer = setTimeout(tick, everyMs * (0.8 + Math.random() * 0.4));
  };
  timer = setTimeout(tick, everyMs * Math.random());
  return () => clearTimeout(timer);
}

export function startSweepers(): () => void {
  const stops = [
    every("outbox", 30_000, async () => {
      const n = await sweepOutbox();
      if (n) console.info(`[sweeper] outbox: published ${n} waiting event(s)`);
    }),
    every("stuck-reviews", 120_000, async () => {
      const { requeued, failed } = await sweepStuckReviews();
      if (requeued || failed) console.info(`[sweeper] stuck reviews: ${requeued} re-queued, ${failed} failed`);
    }),
  ];
  return () => stops.forEach((s) => s());
}
