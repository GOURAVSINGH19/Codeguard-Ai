import { NextResponse } from "next/server";
import { GitHubAppService } from "@/services/GitHubAppService";
import { createHmac, timingSafeEqual } from "crypto";
import { db, githubInstallations, repositories, webhookEvents } from "@codeguard/db";
import { eq, inArray } from "drizzle-orm";
import { createProducer, TOPICS } from "@codeguard/kafka";
import type { WebhookReceivedEvent } from "@codeguard/kafka";

export async function POST(req: Request) {
  const rawBody = await req.text();

  // Verify signature
  const signatureHeader = req.headers.get("x-hub-signature-256");
  const webhookSecret = process.env.GITHUB_APP_WEBHOOK_SECRET || process.env.GITHUB_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.warn("[github-app-webhook] GITHUB_APP_WEBHOOK_SECRET / GITHUB_WEBHOOK_SECRET not set");
    return NextResponse.json({ error: "Not configured. Please add GITHUB_APP_WEBHOOK_SECRET in Vercel environment variables." }, { status: 500 });
  }

  if (!signatureHeader) {
    console.warn("[github-app-webhook] Missing signature header");
    return NextResponse.json({ error: "Missing signature" }, { status: 401 });
  }

  const expected = "sha256=" + createHmac("sha256", webhookSecret)
    .update(rawBody)
    .digest("hex");

  const sigBuf = Buffer.from(signatureHeader);
  const expBuf = Buffer.from(expected);

  const isValid =
    sigBuf.length === expBuf.length && timingSafeEqual(sigBuf, expBuf);

  if (!isValid) {
    console.warn("[github-app-webhook] Invalid signature");
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  // Parse event
  const githubEvent = req.headers.get("x-github-event") ?? "unknown";
  const deliveryId = req.headers.get("x-github-delivery") ?? crypto.randomUUID();

  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    console.error("[github-app-webhook] Invalid JSON payload");
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Save raw event
  await db.insert(webhookEvents).values({
    githubDeliveryId: deliveryId,
    event: githubEvent,
    action: payload?.action,
    payload,
    status: "received",
  }).catch((err) => console.error("[github-app-webhook] DB error:", err));

  // Handle installation events
  if (githubEvent === "installation") {
    const action = payload?.action;
    const installation = payload?.installation;

    if (action && installation) {
      const appService = GitHubAppService.fromEnv();
      await appService.handleInstallationEvent(action, installation);
    }
  }

  // Handle installation_repositories events (repos added/removed from installation)
  if (githubEvent === "installation_repositories") {
    const action = payload?.action;
    const installation = payload?.installation;

    if (action && installation) {
      const appService = GitHubAppService.fromEnv();
      if (action === "added") {
        await appService.syncInstallationRepositories(installation.id);
      } else if (action === "removed") {
        // Mark repositories as inactive
        const [installationRecord] = await db
          .select()
          .from(githubInstallations)
          .where(eq(githubInstallations.installationId, Number(installation.id)))
          .limit(1);

        if (installationRecord) {
          const removedRepoIds = payload.repositories_removed?.map((r: any) => Number(r.id)) || [];
          if (removedRepoIds.length > 0) {
            await db
              .update(repositories)
              .set({ status: "inactive", updatedAt: new Date() })
              .where(inArray(repositories.githubRepoId, removedRepoIds));
          }
        }
      }
    }
  }

  // Also publish to Kafka for async processing
  try {
    const event: WebhookReceivedEvent = {
      githubEvent,
      deliveryId,
      payload: rawBody,
      receivedAt: new Date().toISOString(),
    };

    const producer = await createProducer();
    await producer.send({
      topic: TOPICS.WEBHOOK_RECEIVED,
      messages: [
        {
          key: deliveryId,
          value: JSON.stringify(event),
        },
      ],
    });
    await producer.disconnect();
  } catch (err) {
    console.error("[github-app-webhook] Failed to publish to Kafka:", err);
  }

  return NextResponse.json({ received: true });
}