import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { db, webhookEvents } from "@codeguard/db";
import { createProducer, TOPICS } from "@codeguard/kafka";
import type { WebhookReceivedEvent } from "@codeguard/kafka";

/**
 * POST /api/webhooks/github
 *
 * Receives GitHub webhook payloads and fans them out to Kafka.
 *
 * Security:
 *  - Verifies X-Hub-Signature-256 HMAC (SHA-256) using GITHUB_WEBHOOK_SECRET
 *  - Uses timingSafeEqual to prevent timing attacks on the signature comparison
 *
 * Design:
 *  - Saves raw event to webhook_events table immediately (audit trail)
 *  - Publishes to Kafka topic for async processing
 *  - Always returns 200 to GitHub (GitHub retries on non-2xx)
 */
export async function POST(req: Request) {
  const rawBody = await req.text();

  // ── 1. Verify HMAC signature ─────────────────────────────────────────────
  const signatureHeader = req.headers.get("x-hub-signature-256");
  const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;

  if (webhookSecret) {
    if (!signatureHeader) {
      console.warn("[webhook] Missing X-Hub-Signature-256 header");
      return NextResponse.json({ error: "Missing signature" }, { status: 401 });
    }

    const expected = "sha256=" + createHmac("sha256", webhookSecret)
      .update(rawBody)
      .digest("hex");

    const sigBuf = Buffer.from(signatureHeader);
    const expBuf = Buffer.from(expected);

    // Buffers must be same length for timingSafeEqual — mismatch = instant reject
    const isValid =
      sigBuf.length === expBuf.length &&
      timingSafeEqual(sigBuf, expBuf);

    if (!isValid) {
      console.warn("[webhook] Invalid HMAC signature");
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }
  } else {
    // No secret configured — allow in dev, warn loudly
    console.warn(
      "[webhook] GITHUB_WEBHOOK_SECRET not set — skipping signature check (dev only)"
    );
  }

  // ── 2. Extract event metadata ────────────────────────────────────────────
  const githubEvent = req.headers.get("x-github-event") ?? "unknown";
  const deliveryId = req.headers.get("x-github-delivery") ?? crypto.randomUUID();

  // ── 3. Persist raw event to DB (fire-and-forget, non-blocking) ───────────
  db.insert(webhookEvents)
    .values({
      githubDeliveryId: deliveryId,
      event: githubEvent,
      action: safeParseAction(rawBody),
      payload: JSON.parse(rawBody),
      status: "received",
    })
    .catch((err) =>
      console.error("[webhook] Failed to persist webhook event:", err)
    );

  // ── 4. Publish to Kafka ──────────────────────────────────────────────────
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
          // Partition by deliveryId so the same repo's events stay ordered
          key: deliveryId,
          value: JSON.stringify(event),
        },
      ],
    });
    await producer.disconnect();
  } catch (err) {
    // Don't return 500 — GitHub would retry which could cause duplicate processing.
    // Log and let the DB record serve as a recovery mechanism.
    console.error("[webhook] Failed to publish to Kafka:", err);
  }

  // ── 5. Always 200 so GitHub doesn't retry ────────────────────────────────
  return NextResponse.json({ received: true });
}

function safeParseAction(rawBody: string): string | undefined {
  try {
    return JSON.parse(rawBody)?.action ?? undefined;
  } catch {
    return undefined;
  }
}
