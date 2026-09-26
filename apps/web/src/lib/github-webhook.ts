import { NextResponse } from "next/server";
import { db, webhookEvents, githubInstallations, repositories, eq, inArray } from "@codeguard/db";
import { getEnv } from "@codeguard/config";
import { getSharedProducer, prMessageKey, TOPICS } from "@codeguard/kafka";
import type { WebhookReceivedEvent } from "@codeguard/kafka";
import { GitHubAppService } from "@/services/GitHubAppService";
import type { AppInstallation } from "@/services/GitHubAppService";
import { verifyGitHubSignature } from "./webhook-signature";

/**
 * One implementation for both webhook endpoints
 * (`/api/webhooks/github-app` and the legacy `/api/webhooks/github`).
 *
 * 1. Verify the HMAC signature — fail CLOSED when no secret is configured
 *    (only `NODE_ENV=development` may skip, with a loud warning).
 * 2. Record the delivery; a repeated `X-GitHub-Delivery` is acknowledged and
 *    dropped, so GitHub redeliveries never produce duplicate reviews.
 * 3. Handle installation events inline (fast DB updates).
 * 4. Publish to Kafka with a per-PR key so events for one PR stay ordered.
 *    If Kafka is down the row stays "received" and the worker's outbox
 *    sweeper publishes it later — no delivery is lost.
 */
/** The few webhook fields this handler reads (GitHub sends many more). */
interface WebhookPayload {
  action?: string;
  repository?: { name?: string; owner?: { login?: string } };
  pull_request?: { number?: number };
  installation?: AppInstallation;
  repositories_removed?: Array<{ id: number }>;
}

export async function handleGitHubWebhook(req: Request, tag: string): Promise<Response> {
  const rawBody = await req.text();
  const env = getEnv();
  const secrets = [env.GITHUB_APP_WEBHOOK_SECRET, env.GITHUB_WEBHOOK_SECRET].filter((s): s is string => Boolean(s));

  if (secrets.length === 0) {
    if (env.NODE_ENV !== "development") {
      console.error(`[${tag}] No webhook secret configured — rejecting request`);
      return NextResponse.json({ error: "Webhook secret not configured" }, { status: 500 });
    }
    console.warn(`[${tag}] GITHUB_APP_WEBHOOK_SECRET not set — skipping signature check (development only)`);
  } else if (!verifyGitHubSignature(rawBody, req.headers.get("x-hub-signature-256"), secrets)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const githubEvent = req.headers.get("x-github-event") ?? "unknown";
  const deliveryId = req.headers.get("x-github-delivery");
  if (!deliveryId) return NextResponse.json({ error: "Missing X-GitHub-Delivery" }, { status: 400 });

  let payload: WebhookPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Awaited (not fire-and-forget): serverless functions can be frozen as soon
  // as the response is sent, which used to lose audit rows.
  const inserted = await db
    .insert(webhookEvents)
    .values({ githubDeliveryId: deliveryId, event: githubEvent, action: payload?.action ?? null, payload, status: "received" })
    .onConflictDoNothing({ target: webhookEvents.githubDeliveryId })
    .returning({ id: webhookEvents.id });

  if (inserted.length === 0) {
    return NextResponse.json({ received: true, duplicate: true });
  }

  try {
    await handleInstallationEvents(githubEvent, payload);
  } catch (err) {
    // Log and continue: the delivery is recorded and GitHub can redeliver.
    console.error(`[${tag}] installation event handling failed:`, err);
  }

  try {
    const event: WebhookReceivedEvent = { githubEvent, deliveryId, payload: rawBody, receivedAt: new Date().toISOString() };
    const producer = await getSharedProducer();
    await producer.send({ topic: TOPICS.WEBHOOK_RECEIVED, messages: [{ key: messageKey(githubEvent, payload, deliveryId), value: JSON.stringify(event) }] });
    await db.update(webhookEvents).set({ status: "processing" }).where(eq(webhookEvents.githubDeliveryId, deliveryId));
  } catch (err) {
    // GitHub does not retry failed deliveries automatically. The row stays in
    // status "received" (an outbox entry) and the workers' outbox sweeper
    // republishes it once Kafka is reachable again.
    console.error(`[${tag}] Kafka publish failed for ${deliveryId}, left in outbox:`, err);
    await db
      .update(webhookEvents)
      .set({ error: "kafka publish failed — queued for retry" })
      .where(eq(webhookEvents.githubDeliveryId, deliveryId))
      .catch(() => {});
  }

  return NextResponse.json({ received: true });
}

/** Per-PR key keeps a PR's events ordered on one partition. */
export function messageKey(githubEvent: string, payload: WebhookPayload, deliveryId: string): string {
  const owner = payload?.repository?.owner?.login;
  const repo = payload?.repository?.name;
  const number = payload?.pull_request?.number;
  if (githubEvent === "pull_request" && owner && repo && number) return prMessageKey(owner, repo, number);
  if (owner && repo) return `${owner}/${repo}`.toLowerCase();
  return deliveryId;
}

async function handleInstallationEvents(githubEvent: string, payload: WebhookPayload): Promise<void> {
  if (githubEvent === "installation" && payload?.action && payload?.installation) {
    await GitHubAppService.fromEnv().handleInstallationEvent(payload.action, payload.installation);
    return;
  }

  if (githubEvent === "installation_repositories" && payload?.installation) {
    const app = GitHubAppService.fromEnv();
    if (payload.action === "added") {
      await app.syncInstallationRepositories(Number(payload.installation.id));
    } else if (payload.action === "removed") {
      const [installation] = await db
        .select({ id: githubInstallations.id })
        .from(githubInstallations)
        .where(eq(githubInstallations.installationId, Number(payload.installation.id)))
        .limit(1);
      const removed = (payload.repositories_removed ?? []).map((r) => Number(r.id));
      if (installation && removed.length > 0) {
        await db
          .update(repositories)
          .set({ status: "inactive", updatedAt: new Date() })
          .where(inArray(repositories.githubRepoId, removed));
      }
    }
  }
}
