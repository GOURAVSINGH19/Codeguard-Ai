import { db, webhookEvents, eq } from "@codeguard/db";
import { getEnv } from "@codeguard/config";
import { publish, TOPICS, WebhookReceived } from "@codeguard/kafka";
import type { GhInstallation, GhRepo } from "./github-app";
import { errorResponse } from "./http";
import {
  deactivateRepositories,
  setInstallationStatus,
  upsertInstallation,
  upsertRepositories,
} from "./installation-sync";
import { verifyGitHubSignature } from "./webhook-signature";

/**
 * Receive one GitHub webhook.
 *
 *   1. verify the HMAC signature           → 401 if wrong
 *   2. INSERT into webhook_events (outbox)  → duplicate delivery id = no-op
 *   3. apply quick DB-only updates (installation / repo lists)
 *   4. publish "webhook.received" to Kafka (≤ 3 s), mark the row "published"
 *   5. answer 200
 *
 * Nothing slow happens here: GitHub gives us 10 s and won't retry on its own.
 * The AI review runs in the workers.
 */
export async function handleGitHubWebhook(req: Request): Promise<Response> {
  try {
    const raw = await req.text(); // raw bytes: needed for the signature
    const { GITHUB_WEBHOOK_SECRET } = getEnv();
    if (!verifyGitHubSignature(raw, req.headers.get("x-hub-signature-256"), GITHUB_WEBHOOK_SECRET)) {
      return Response.json({ error: "invalid signature" }, { status: 401 });
    }

    const deliveryId = req.headers.get("x-github-delivery");
    const eventType = req.headers.get("x-github-event");
    if (!deliveryId || !eventType) return Response.json({ error: "missing GitHub headers" }, { status: 400 });

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw); // parse only AFTER verifying
    } catch {
      return Response.json({ error: "invalid JSON" }, { status: 400 });
    }
    const action = typeof payload.action === "string" ? payload.action : null;

    // Save first. The UNIQUE delivery_id turns a redelivery into "0 rows inserted".
    const inserted = await db
      .insert(webhookEvents)
      .values({ deliveryId, eventType, action, payload })
      .onConflictDoNothing({ target: webhookEvents.deliveryId })
      .returning({ id: webhookEvents.id });

    if (inserted.length === 0) return Response.json({ ok: true, duplicate: true });

    try {
      await applyInstallationEvent(eventType, action, payload);
    } catch (err) {
      // The event is safely stored; record why it couldn't be applied and still answer 200.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[webhook] ${eventType}.${action} ${deliveryId} not applied:`, message);
      await db.update(webhookEvents).set({ error: message }).where(eq(webhookEvents.id, inserted[0].id));
    }

    // Hand off to the workers. If Kafka is down, the row stays "received" and the
    // Day 3 sweeper publishes it later; GitHub still gets its fast 200.
    try {
      await publish(
        TOPICS.webhookReceived,
        deliveryId,
        WebhookReceived,
        { type: "webhook.received", webhookEventId: inserted[0].id, deliveryId, eventType, action },
        { timeoutMs: 3_000 },
      );
      await db
        .update(webhookEvents)
        .set({ status: "published", publishedAt: new Date() })
        .where(eq(webhookEvents.id, inserted[0].id));
    } catch (err) {
      console.warn(`[webhook] ${deliveryId} saved but not published (left for the sweeper):`, (err as Error).message);
    }

    return Response.json({ ok: true });
  } catch (err) {
    // e.g. the database is down: 500 makes GitHub show a failed delivery you can redeliver.
    return errorResponse(err);
  }
}

/** Keep installations/repositories in sync. DB writes only, using data already in the payload. */
export async function applyInstallationEvent(
  eventType: string,
  action: string | null,
  payload: Record<string, unknown>,
): Promise<void> {
  const installation = payload.installation as GhInstallation | undefined;
  if (!installation?.id) return;

  if (eventType === "installation") {
    switch (action) {
      case "created":
        await upsertInstallation(installation, { status: "active" });
        await upsertRepositories(installation.id, (payload.repositories as GhRepo[] | undefined) ?? []);
        return;
      case "deleted":
        return setInstallationStatus(installation.id, "deleted");
      case "suspend":
        return setInstallationStatus(installation.id, "suspended");
      case "unsuspend":
        return setInstallationStatus(installation.id, "active");
      case "new_permissions_accepted":
        return upsertInstallation(installation);
    }
    return;
  }

  if (eventType === "installation_repositories") {
    await upsertInstallation(installation); // make sure the parent row exists (events can arrive out of order)
    await upsertRepositories(installation.id, (payload.repositories_added as GhRepo[] | undefined) ?? []);
    await deactivateRepositories(
      ((payload.repositories_removed as GhRepo[] | undefined) ?? []).map((r) => r.id),
    );
  }
}
