import { z } from "zod";
import {
  TOPICS,
  WebhookReceivedEventSchema,
  GitHubPushEventSchema,
} from "@codeguard/kafka";
import type { ReviewRequestedEvent, IndexIncrementalEvent, GitHubPushEvent } from "@codeguard/kafka";
import type { EachMessagePayload } from "kafkajs";
import { db, webhookEvents, repositories, eq } from "@codeguard/db";
import { getWorkerConsumer, getWorkerProducer } from "../queue/kafkaClient.js";

const CONSUMER_GROUP = "codeguard-webhook-processor";

/**
 * webhookProcessor
 *
 * Consumes: codeguard.webhook.received
 * Publishes: codeguard.review.requested  (for pull_request opened/synchronize)
 *            codeguard.index.incremental  (for push events to indexed repos)
 *
 * Responsibilities:
 *  1. Parse + validate the raw GitHub webhook payload
 *  2. Filter for actionable PR events (opened / synchronize) → review.requested
 *  3. Filter for push events to indexed repos → index.incremental
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

      // ── 2. Handle pull_request events (existing logic) ────────────────────
      if (envelope.githubEvent === "pull_request") {
        await handlePullRequestEvent(envelope, producer);
        return;
      }

      // ── 3. Handle push events (new incremental indexing) ──────────────────
      if (envelope.githubEvent === "push") {
        await handlePushEvent(envelope, producer);
        return;
      }

      // ── 4. Ignore other events ────────────────────────────────────────────
      await markWebhookStatus(envelope.deliveryId, "ignored");
    },
  });
}

async function handlePullRequestEvent(
  envelope: z.infer<typeof WebhookReceivedEventSchema>,
  producer: Awaited<ReturnType<typeof getWorkerProducer>>
): Promise<void> {
  // Parse PR payload
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

  // Extract PR coordinates
  const prNumber: number = payload?.pull_request?.number;
  const owner: string = payload?.repository?.owner?.login;
  const repo: string = payload?.repository?.name;

  if (!prNumber || !owner || !repo) {
    console.warn("[webhookProcessor] Missing PR coordinates in payload");
    await markWebhookStatus(envelope.deliveryId, "failed");
    return;
  }

  // Publish review.requested
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
}

async function handlePushEvent(
  envelope: z.infer<typeof WebhookReceivedEventSchema>,
  producer: Awaited<ReturnType<typeof getWorkerProducer>>
): Promise<void> {
  // Parse push payload
  let pushPayload: GitHubPushEvent;
  try {
    const parsed = GitHubPushEventSchema.safeParse(JSON.parse(envelope.payload));
    if (!parsed.success) {
      console.warn("[webhookProcessor] Invalid push payload:", parsed.error.issues);
      await markWebhookStatus(envelope.deliveryId, "failed");
      return;
    }
    pushPayload = parsed.data;
  } catch {
    console.error("[webhookProcessor] Could not parse push payload JSON");
    await markWebhookStatus(envelope.deliveryId, "failed");
    return;
  }

  const owner = pushPayload.repository.owner.login;
  const repo = pushPayload.repository.name;
  const headSha = pushPayload.after;
  const pusher = pushPayload.pusher.name;

  // Skip if this is a branch deletion (all zeros SHA)
  if (headSha === "0000000000000000000000000000000000000000") {
    console.log(`[webhookProcessor] Branch deleted, skipping index for ${owner}/${repo}`);
    await markWebhookStatus(envelope.deliveryId, "ignored");
    return;
  }

  // Look up repository in our DB to get repositoryId
  const [repoRecord] = await db
    .select({ id: repositories.id })
    .from(repositories)
    .where(eq(repositories.fullName, `${owner}/${repo}`))
    .limit(1);

  if (!repoRecord) {
    // Repository not indexed yet — ignore silently
    console.log(`[webhookProcessor] Repo ${owner}/${repo} not indexed, skipping incremental index`);
    await markWebhookStatus(envelope.deliveryId, "ignored");
    return;
  }

  // Extract changed files from commits
  const changedFiles = new Set<string>();
  for (const commit of pushPayload.commits ?? []) {
    for (const file of [...(commit.added ?? []), ...(commit.removed ?? []), ...(commit.modified ?? [])]) {
      changedFiles.add(file);
    }
  }

  if (changedFiles.size === 0) {
    console.log(`[webhookProcessor] No files changed in push to ${owner}/${repo}`);
    await markWebhookStatus(envelope.deliveryId, "ignored");
    return;
  }

  // Publish index.incremental event
  const indexEvent: IndexIncrementalEvent = {
    owner,
    repo,
    repositoryId: repoRecord.id,
    changedFiles: Array.from(changedFiles),
    headSha,
    pusher,
    triggeredAt: new Date().toISOString(),
  };

  await producer.send({
    topic: TOPICS.INDEX_INCREMENTAL,
    messages: [
      {
        key: `${owner}/${repo}`,
        value: JSON.stringify(indexEvent),
      },
    ],
  });

  console.log(
    `[webhookProcessor] → index.incremental for ${owner}/${repo} (${changedFiles.size} files changed)`
  );

  await markWebhookStatus(envelope.deliveryId, "processed");
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
    .catch((err: any) =>
      console.warn("[webhookProcessor] Could not update webhook status:", err)
    );
}
