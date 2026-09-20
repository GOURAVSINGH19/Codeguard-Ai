import {
  TOPICS,
  WebhookReceivedEventSchema,
  ReviewRequestedEventSchema,
} from "@codeguard/kafka";
import type { ReviewRequestedEvent } from "@codeguard/kafka";
import type { EachMessagePayload } from "kafkajs";
import { db, webhookEvents } from "@codeguard/db";
import { eq } from "drizzle-orm";
import { getWorkerConsumer, getWorkerProducer } from "../queue/kafkaClient.js";

const CONSUMER_GROUP = "codeguard-webhook-processor";

/**
 * webhookProcessor
 *
 * Consumes: codeguard.webhook.received
 * Publishes: codeguard.review.requested  (for pull_request opened/synchronize)
 *
 * Responsibilities:
 *  1. Parse + validate the raw GitHub webhook payload
 *  2. Filter for actionable PR events (opened / synchronize)
 *  3. Publish a typed review.requested event for the reviewProcessor
 *  4. Update webhook_events.status in DB (received → processed / ignored / failed)
 */
export async function startWebhookProcessor(): Promise<void> {
  const consumer = await getWorkerConsumer(CONSUMER_GROUP);
  const producer = await getWorkerProducer();

  await consumer.subscribe({
    topic: TOPICS.WEBHOOK_RECEIVED,
    fromBeginning: false,
  });

  console.log(
    `[webhookProcessor] Listening on topic: ${TOPICS.WEBHOOK_RECEIVED}`
  );

  await consumer.run({
    // Process one message at a time — prevents out-of-order review triggers
    eachMessage: async ({ message }: EachMessagePayload) => {
      const raw = message.value?.toString();
      if (!raw) return;

      // ── 1. Validate the incoming event envelope ─────────────────────────
      const envelopeParse = WebhookReceivedEventSchema.safeParse(
        JSON.parse(raw)
      );
      if (!envelopeParse.success) {
        console.warn(
          "[webhookProcessor] Invalid event envelope:",
          envelopeParse.error.issues
        );
        return;
      }
      const envelope = envelopeParse.data;

      // ── 2. Only handle pull_request events ──────────────────────────────
      if (envelope.githubEvent !== "pull_request") {
        await markWebhookStatus(envelope.deliveryId, "ignored");
        return;
      }

      // ── 3. Parse PR payload ──────────────────────────────────────────────
      let payload: any;
      try {
        payload = JSON.parse(envelope.payload);
      } catch {
        console.error("[webhookProcessor] Could not parse payload JSON");
        await markWebhookStatus(envelope.deliveryId, "failed");
        return;
      }

      const action: string = payload?.action ?? "";
      const actionable = ["opened", "synchronize", "reopened"];

      if (!actionable.includes(action)) {
        await markWebhookStatus(envelope.deliveryId, "ignored");
        return;
      }

      // ── 4. Extract PR coordinates ────────────────────────────────────────
      const prNumber: number = payload?.pull_request?.number;
      const owner: string = payload?.repository?.owner?.login;
      const repo: string = payload?.repository?.name;

      if (!prNumber || !owner || !repo) {
        console.warn("[webhookProcessor] Missing PR coordinates in payload");
        await markWebhookStatus(envelope.deliveryId, "failed");
        return;
      }

      // ── 5. Publish review.requested ─────────────────────────────────────
      const reviewEvent: ReviewRequestedEvent = {
        owner,
        repo,
        pullNumber: prNumber,
        userId: null, // bot-triggered — no Clerk user
        triggeredBy: "webhook",
        requestedAt: new Date().toISOString(),
      };

      await producer.send({
        topic: TOPICS.REVIEW_REQUESTED,
        messages: [
          {
            key: `${owner}/${repo}/${prNumber}`,
            value: JSON.stringify(reviewEvent),
          },
        ],
      });

      console.log(
        `[webhookProcessor] → review.requested for ${owner}/${repo}#${prNumber}`
      );

      await markWebhookStatus(envelope.deliveryId, "processed");
    },
  });
}

async function markWebhookStatus(
  deliveryId: string,
  status: "processed" | "ignored" | "failed"
) {
  await db
    .update(webhookEvents)
    .set({
      status,
      processedAt: status === "processed" ? new Date() : undefined,
    })
    .where(eq(webhookEvents.githubDeliveryId, deliveryId))
    .catch((err) =>
      console.warn("[webhookProcessor] Could not update webhook status:", err)
    );
}
