import { db, webhookEvents, eq, and, or, lt, gt, asc, isNotNull } from "@codeguard/db";
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
 */
const INTERVAL_MS = Number(process.env.OUTBOX_SWEEP_INTERVAL_MS) || 60_000;
const MIN_AGE_MS = process.env.OUTBOX_MIN_AGE_MS !== undefined && process.env.OUTBOX_MIN_AGE_MS !== "" ? Number(process.env.OUTBOX_MIN_AGE_MS) : 60_000;
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

export function startWebhookOutboxSweeper(): void {
  const log = logger.child({ job: "webhookOutboxSweeper" });
  let running = false;
  const tick = async () => {
    if (running) return; // a slow sweep must not overlap the next one
    running = true;
    try {
      const now = Date.now();
      const stuck = await db
        .select()
        .from(webhookEvents)
        .where(
          and(
            eq(webhookEvents.status, "received"),
            or(isNotNull(webhookEvents.error), lt(webhookEvents.createdAt, new Date(now - MIN_AGE_MS))),
            gt(webhookEvents.createdAt, new Date(now - 24 * 60 * 60_000))
          )
        )
        .orderBy(asc(webhookEvents.createdAt))
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
        const key = outboxKey(row.payload, row.event, row.githubDeliveryId);
        await producer.send({ topic: TOPICS.WEBHOOK_RECEIVED, messages: [{ key, value: JSON.stringify(event) }] });
        await db.update(webhookEvents).set({ status: "processing", error: null }).where(eq(webhookEvents.id, row.id));
      }
      log.info("published webhook deliveries from the outbox", { count: stuck.length });
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
