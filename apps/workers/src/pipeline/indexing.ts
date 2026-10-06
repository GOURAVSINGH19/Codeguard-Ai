import { TOPICS } from "@codeguard/kafka";
import type { IndexFullEvent } from "@codeguard/kafka";
import { getWorkerProducer } from "../queue/kafkaClient.js";
import { hasChunks } from "../jobs/fullIndexer.js";
import type { Logger } from "../lib/logger.js";

/** Ask for a full index when a reviewed repository has none. Best-effort. */
export async function requestIndexIfMissing(repositoryId: string, owner: string, repo: string, installationId: number | null, log: Logger): Promise<void> {
  try {
    if (await hasChunks(repositoryId)) return;
    const event: IndexFullEvent = { owner, repo, repositoryId, installationId, reason: "backfill", triggeredAt: new Date().toISOString() };
    const producer = await getWorkerProducer();
    await producer.send({ topic: TOPICS.INDEX_FULL, messages: [{ key: `${owner}/${repo}`.toLowerCase(), value: JSON.stringify(event) }] });
    log.info("repository has no index, full index requested");
  } catch (err) {
    log.warn("could not request full index", { error: (err as Error).message });
  }
}
