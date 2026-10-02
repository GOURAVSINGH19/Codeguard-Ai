import { TOPICS, WebhookReceivedEventSchema, GitHubPushEventSchema, prMessageKey } from "@codeguard/kafka";
import type { ReviewRequestedEvent, IndexIncrementalEvent, IndexFullEvent, WebhookReceivedEvent } from "@codeguard/kafka";
import { db, webhookEvents, repositories, eq } from "@codeguard/db";
import { getWorkerProducer } from "../queue/kafkaClient.js";
import { runConsumer, PermanentError } from "../queue/consumer.js";
import { logger } from "../lib/logger.js";

const CONSUMER_GROUP = "codeguard-webhook-processor";

/** PR actions that should trigger a review. */
export const REVIEWABLE_PR_ACTIONS = new Set(["opened", "synchronize", "reopened", "ready_for_review"]);

/**
 * webhookProcessor
 *
 * Consumes: codeguard.webhook.received
 * Publishes: codeguard.review.requested  (PR opened / synchronize / reopened / ready_for_review
 *                                          on repos with auto-review enabled)
 *            codeguard.index.incremental  (pushes to the default branch of known repos)
 *            codeguard.index.full         (App installed / repositories added to an installation)
 */
export async function startWebhookProcessor(): Promise<void> {
  await runConsumer({
    name: "webhookProcessor",
    groupId: CONSUMER_GROUP,
    topic: TOPICS.WEBHOOK_RECEIVED,
    schema: WebhookReceivedEventSchema,
    handler: routeWebhook,
  });
}

export type RouteOutcome =
  | { kind: "review"; event: ReviewRequestedEvent }
  | { kind: "index"; event: IndexIncrementalEvent }
  | { kind: "index-full"; events: IndexFullEvent[] }
  | { kind: "ignored"; reason: string };

export interface RepoLookup {
  (fullName: string): Promise<{ id: string; autoReviewEnabled: boolean; defaultBranch: string; status: string } | null>;
}

const lookupRepo: RepoLookup = async (fullName) => {
  const [row] = await db
    .select({
      id: repositories.id,
      autoReviewEnabled: repositories.autoReviewEnabled,
      defaultBranch: repositories.defaultBranch,
      status: repositories.status,
    })
    .from(repositories)
    .where(eq(repositories.fullName, fullName))
    .limit(1);
  return row ?? null;
};

/**
 * Pure routing decision — no Kafka, easy to unit test. DB access is injected.
 */
export async function decideRoute(envelope: WebhookReceivedEvent, findRepo: RepoLookup = lookupRepo): Promise<RouteOutcome> {
  let payload: any;
  try {
    payload = JSON.parse(envelope.payload);
  } catch {
    throw new PermanentError("webhook payload is not valid JSON");
  }

  if (envelope.githubEvent === "pull_request") {
    const action: string = payload?.action ?? "";
    if (!REVIEWABLE_PR_ACTIONS.has(action)) return { kind: "ignored", reason: `action ${action || "(none)"}` };

    const pr = payload?.pull_request;
    const owner: string | undefined = payload?.repository?.owner?.login;
    const repo: string | undefined = payload?.repository?.name;
    if (!pr?.number || !owner || !repo || !pr?.head?.sha) throw new PermanentError("pull_request payload missing coordinates");
    if (pr.draft) return { kind: "ignored", reason: "draft PR" };

    const repoRecord = await findRepo(`${owner}/${repo}`);
    if (!repoRecord || repoRecord.status !== "active") return { kind: "ignored", reason: "repository not connected" };
    if (!repoRecord.autoReviewEnabled) return { kind: "ignored", reason: "auto-review disabled for repository" };

    return {
      kind: "review",
      event: {
        owner,
        repo,
        pullNumber: pr.number,
        userId: null, // bot-triggered — no Clerk user
        triggeredBy: "webhook",
        installationId: typeof payload?.installation?.id === "number" ? payload.installation.id : null,
        headSha: pr.head.sha,
        previousHeadSha: action === "synchronize" && typeof payload?.before === "string" ? payload.before : null,
        deliveryId: envelope.deliveryId,
        requestedAt: new Date().toISOString(),
      },
    };
  }

  if (envelope.githubEvent === "push") {
    const parsed = GitHubPushEventSchema.safeParse(payload);
    if (!parsed.success) throw new PermanentError("invalid push payload");
    const push = parsed.data;
    const owner = push.repository.owner.login;
    const repo = push.repository.name;

    if (/^0+$/.test(push.after)) return { kind: "ignored", reason: "branch deleted" };

    const repoRecord = await findRepo(`${owner}/${repo}`);
    if (!repoRecord) return { kind: "ignored", reason: "repository not connected" };

    // Only the default branch feeds the code index — feature branches would
    // pollute review context with unmerged code.
    if (push.ref !== `refs/heads/${repoRecord.defaultBranch}`) return { kind: "ignored", reason: `push to ${push.ref}` };

    const changedFiles = new Set<string>();
    for (const commit of push.commits ?? []) {
      for (const file of [...(commit.added ?? []), ...(commit.removed ?? []), ...(commit.modified ?? [])]) {
        changedFiles.add(file);
      }
    }
    if (changedFiles.size === 0) return { kind: "ignored", reason: "no files changed" };

    return {
      kind: "index",
      event: {
        owner,
        repo,
        repositoryId: repoRecord.id,
        changedFiles: [...changedFiles],
        headSha: push.after,
        ref: push.ref,
        installationId: typeof payload?.installation?.id === "number" ? payload.installation.id : null,
        pusher: push.pusher.name,
        triggeredAt: new Date().toISOString(),
      },
    };
  }

  // The web app syncs these repositories into the DB before publishing the
  // delivery, so they can be looked up here. Index them so RAG and the
  // dependency graph have data before the first PR arrives.
  const installed = envelope.githubEvent === "installation" && payload?.action === "created";
  const added = envelope.githubEvent === "installation_repositories" && payload?.action === "added";
  if (installed || added) {
    const listed: Array<{ full_name?: string }> = (installed ? payload?.repositories : payload?.repositories_added) ?? [];
    const installationId = typeof payload?.installation?.id === "number" ? payload.installation.id : null;
    const events: IndexFullEvent[] = [];
    for (const { full_name } of listed) {
      if (!full_name) continue;
      const repoRecord = await findRepo(full_name);
      if (!repoRecord || repoRecord.status !== "active") continue;
      const [owner, repo] = full_name.split("/");
      events.push({
        owner,
        repo,
        repositoryId: repoRecord.id,
        installationId,
        reason: installed ? "installed" : "repository_added",
        triggeredAt: new Date().toISOString(),
      });
    }
    if (events.length === 0) return { kind: "ignored", reason: "no connected repositories to index" };
    return { kind: "index-full", events };
  }

  return { kind: "ignored", reason: `event ${envelope.githubEvent}` };
}

async function routeWebhook(envelope: WebhookReceivedEvent): Promise<void> {
  const log = logger.child({ deliveryId: envelope.deliveryId, githubEvent: envelope.githubEvent });
  let outcome: RouteOutcome;
  try {
    outcome = await decideRoute(envelope);
  } catch (err) {
    await markWebhookStatus(envelope.deliveryId, "failed", (err as Error).message);
    throw err;
  }

  const producer = await getWorkerProducer();

  if (outcome.kind === "review") {
    const e = outcome.event;
    await producer.send({
      topic: TOPICS.REVIEW_REQUESTED,
      messages: [{ key: prMessageKey(e.owner, e.repo, e.pullNumber), value: JSON.stringify(e) }],
    });
    log.info("review requested", { pr: `${e.owner}/${e.repo}#${e.pullNumber}`, headSha: e.headSha });
    await markWebhookStatus(envelope.deliveryId, "processed");
    return;
  }

  if (outcome.kind === "index") {
    const e = outcome.event;
    await producer.send({
      topic: TOPICS.INDEX_INCREMENTAL,
      messages: [{ key: `${e.owner}/${e.repo}`.toLowerCase(), value: JSON.stringify(e) }],
    });
    log.info("incremental index requested", { repo: `${e.owner}/${e.repo}`, files: e.changedFiles.length });
    await markWebhookStatus(envelope.deliveryId, "processed");
    return;
  }

  if (outcome.kind === "index-full") {
    await producer.send({
      topic: TOPICS.INDEX_FULL,
      messages: outcome.events.map((e) => ({ key: `${e.owner}/${e.repo}`.toLowerCase(), value: JSON.stringify(e) })),
    });
    log.info("full index requested", { repos: outcome.events.map((e) => `${e.owner}/${e.repo}`) });
    await markWebhookStatus(envelope.deliveryId, "processed");
    return;
  }

  log.debug("ignored", { reason: outcome.reason });
  await markWebhookStatus(envelope.deliveryId, "ignored");
}

async function markWebhookStatus(deliveryId: string, status: "processed" | "ignored" | "failed", error?: string) {
  await db
    .update(webhookEvents)
    .set({ status, processedAt: new Date(), error: error?.slice(0, 500) ?? null })
    .where(eq(webhookEvents.githubDeliveryId, deliveryId))
    .catch((err: unknown) => logger.warn("could not update webhook status", { deliveryId, error: String(err) }));
}
