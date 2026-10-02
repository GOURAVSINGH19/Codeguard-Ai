import { db, webhookEvents, eq, and, or, lt, gt, isNotNull } from "@codeguard/db";
import { TOPICS } from "@codeguard/kafka";
import type { WebhookReceivedEvent } from "@codeguard/kafka";
import { getWorkerProducer } from "../queue/kafkaClient.js";
import { logger } from "../lib/logger.js";

/**
 * Transactional-outbox sweeper.
 *
 * The web app stores every webhook delivery before publishing it. If the
 * publish failed (Kafka down, cold start timeout) the row stays in status
 * "received". We republish rows less than a day old that either carry the web
 * app's publish error (that attempt is over, so no race) or have been stuck for
 * over a minute (the web app died before recording the error). Duplicates are
 * harmless: reviews are claimed per (PR, head SHA) and indexing is idempotent.
 *
 * OUTBOX_SWEEP_INTERVAL_MS shortens the interval — local mode relies on the
 * sweeper for every event, so it sweeps every few seconds.
 */
const INTERVAL_MS = Number(process.env.OUTBOX_SWEEP_INTERVAL_MS) || 60_000;
const BATCH = 50;

let timer: NodeJS.Timeout | null = null;

export function startWebhookOutboxSweeper(): void {
  const log = logger.child({ job: "webhookOutboxSweeper" });
  const tick = async () => {
    try {
      const now = Date.now();
      const stuck = await db
        .select()
        .from(webhookEvents)
        .where(
          and(
            eq(webhookEvents.status, "received"),
            or(isNotNull(webhookEvents.error), lt(webhookEvents.createdAt, new Date(now - 60_000))),
            gt(webhookEvents.createdAt, new Date(now - 24 * 60 * 60_000))
          )
        )
        .limit(BATCH);
      if (stuck.length === 0) return;

      const producer = await getWorkerProducer();
      for (const row of stuck) {
        if (!row.githubDeliveryId) continue;
        const event: WebhookReceivedEvent = {
          githubEvent: row.event,
          deliveryId: row.githubDeliveryId,
          payload: JSON.stringify(row.payload),
          receivedAt: row.createdAt.toISOString(),
        };
        await producer.send({ topic: TOPICS.WEBHOOK_RECEIVED, messages: [{ key: row.githubDeliveryId, value: JSON.stringify(event) }] });
        await db.update(webhookEvents).set({ status: "processing", error: null }).where(eq(webhookEvents.id, row.id));
      }
      log.info("republished stuck webhook deliveries", { count: stuck.length });
    } catch (err) {
      log.warn("outbox sweep failed", { error: (err as Error).message });
    }
  };
  timer = setInterval(tick, INTERVAL_MS);
  void tick();
}

export function stopWebhookOutboxSweeper(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
