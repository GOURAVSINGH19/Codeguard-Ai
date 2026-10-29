import { db, webhookEvents, eq, and, or, lt, gt, asc, isNotNull, sql } from "@codeguard/db";
import { TOPICS, prMessageKey } from "@codeguard/kafka";
import type { WebhookReceivedEvent } from "@codeguard/kafka";
import { getWorkerProducer } from "../queue/kafkaClient.js";
import { logger } from "../lib/logger.js";

/**
 * Transactional-outbox sweeper.
 *
 * The web app stores every webhook delivery before publishing it. If the
 * publish failed (Kafka down, cold start timeout) the row stays in status
 * "received". We republish rows less than a day old that either carry the web
 * app's publish error (that attempt is over, so no race) or are older than
 * OUTBOX_MIN_AGE_MS (the web app died before recording the error). Duplicates
 * are harmless: reviews are claimed per (PR, head SHA) and indexing is idempotent.
 *
 * When the web app cannot reach Kafka at all (KAFKA_PUBLISH_FROM_WEB=false,
 * e.g. Kafka as a Render private service) every event arrives this way, so
 * deployments set OUTBOX_SWEEP_INTERVAL_MS to a few seconds and
 * OUTBOX_MIN_AGE_MS to 0.
 *
 * It also resends rows stuck in "processing" (published, never finished) and
 * gives up with status "failed" after MAX_PUBLISH_ATTEMPTS.
 */
const INTERVAL_MS = Number(process.env.OUTBOX_SWEEP_INTERVAL_MS) || 60_000;
const MIN_AGE_MS = process.env.OUTBOX_MIN_AGE_MS !== undefined && process.env.OUTBOX_MIN_AGE_MS !== "" ? Number(process.env.OUTBOX_MIN_AGE_MS) : 60_000;
/**
 * A delivery still "processing" this long after it was published was lost on
 * the way (webhook routing takes milliseconds). Resent, up to MAX_PUBLISH_ATTEMPTS.
 */
const PROCESSING_STALE_MS = Number(process.env.OUTBOX_PROCESSING_STALE_MS) || 10 * 60_000;
const MAX_PUBLISH_ATTEMPTS = 5;
const BATCH = 50;

let timer: NodeJS.Timeout | null = null;

/** Same keys the web app uses, so one PR's events stay ordered on one partition. */
export function outboxKey(payload: unknown, githubEvent: string, deliveryId: string): string {
  const p = payload as { repository?: { name?: string; owner?: { login?: string } }; pull_request?: { number?: number } } | null;
  const owner = p?.repository?.owner?.login;
  const repo = p?.repository?.name;
  const number = p?.pull_request?.number;
  if (githubEvent === "pull_request" && owner && repo && number) return prMessageKey(owner, repo, number);
  if (owner && repo) return `${owner}/${repo}`.toLowerCase();
  return deliveryId;
}

/** Decide what to do with a stuck row: publish it again, or give up on it. */
export function classifyOutboxRow(row: { publishAttempts: number }): "resend" | "abandon" {
  return row.publishAttempts >= MAX_PUBLISH_ATTEMPTS ? "abandon" : "resend";
}

/**
 * One sweep. Returns how many deliveries were republished and how many were
 * given up on. Exported so it can be tested without timers.
 */
export async function sweepOutbox(now = Date.now()): Promise<{ republished: number; abandoned: number }> {
  const stuck = await db
    .select()
    .from(webhookEvents)
    .where(
      and(
        or(
          // Never reached Kafka: the web app recorded a publish error, or it died before it could.
          and(eq(webhookEvents.status, "received"), or(isNotNull(webhookEvents.error), lt(webhookEvents.createdAt, new Date(now - MIN_AGE_MS)))),
          // Reached Kafka, but nobody finished it (message lost, group started late, broker data loss).
          and(eq(webhookEvents.status, "processing"), lt(sql`coalesce(${webhookEvents.lastPublishedAt}, ${webhookEvents.createdAt})`, new Date(now - PROCESSING_STALE_MS)))
        ),
        gt(webhookEvents.createdAt, new Date(now - 24 * 60 * 60_000))
      )
    )
    .orderBy(asc(webhookEvents.createdAt))
    .limit(BATCH);
  if (stuck.length === 0) return { republished: 0, abandoned: 0 };

  const producer = await getWorkerProducer();
  let republished = 0;
  let abandoned = 0;
  for (const row of stuck) {
    if (!row.githubDeliveryId) continue;

    if (classifyOutboxRow(row) === "abandon") {
      await db
        .update(webhookEvents)
        .set({ status: "failed", error: `not processed after ${row.publishAttempts} publish attempts`, processedAt: new Date(now) })
        .where(eq(webhookEvents.id, row.id));
      abandoned++;
      continue;
    }

    const event: WebhookReceivedEvent = {
      githubEvent: row.event,
      deliveryId: row.githubDeliveryId,
      payload: JSON.stringify(row.payload),
      receivedAt: row.createdAt.toISOString(),
    };
    const key = outboxKey(row.payload, row.event, row.githubDeliveryId);
    await producer.send({ topic: TOPICS.WEBHOOK_RECEIVED, messages: [{ key, value: JSON.stringify(event) }] });
    await db
      .update(webhookEvents)
      .set({ status: "processing", error: null, lastPublishedAt: new Date(now), publishAttempts: row.publishAttempts + 1 })
      .where(eq(webhookEvents.id, row.id));
    republished++;
  }
  return { republished, abandoned };
}

export function startWebhookOutboxSweeper(): void {
  const log = logger.child({ job: "webhookOutboxSweeper" });
  let running = false;
  const tick = async () => {
    if (running) return; // a slow sweep must not overlap the next one
    running = true;
    try {
      const result = await sweepOutbox();
      if (result.republished || result.abandoned) log.info("outbox sweep", result);
    } catch (err) {
      log.warn("outbox sweep failed", { error: (err as Error).message });
    } finally {
      running = false;
    }
  };
  timer = setInterval(tick, INTERVAL_MS);
  void tick();
}

export function stopWebhookOutboxSweeper(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
