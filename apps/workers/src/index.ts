import "dotenv/config";
import { getEnv } from "@codeguard/config";
import { ensureTopicsExist } from "@codeguard/kafka";
import { startWebhookProcessor } from "./jobs/webhookProcessor.js";
import { startReviewProcessor } from "./jobs/reviewProcessor.js";
import { startIncrementalIndexer } from "./jobs/incrementalIndexer.js";
import { startWebhookOutboxSweeper, stopWebhookOutboxSweeper } from "./jobs/webhookOutboxSweeper.js";
import { disconnectProducer } from "./queue/kafkaClient.js";
import { disconnectConsumers } from "./queue/consumer.js";
import { logger } from "./lib/logger.js";

// Export indexRepository so it can be run directly:
//   npx tsx src/index.ts index <owner> <repo> <repositoryId>
export { indexRepository } from "./jobs/indexRepository.js";
export { startIncrementalIndexer } from "./jobs/incrementalIndexer.js";

/**
 * Start all consumer workers concurrently.
 * Each processor runs an infinite consumer loop — they do not resolve.
 */
async function main() {
  // Fail fast on a malformed environment (bad enum, non-numeric port, …).
  getEnv();

  await ensureTopicsExist();
  startWebhookOutboxSweeper();

  await Promise.all(
    [
      ["webhookProcessor", startWebhookProcessor],
      ["reviewProcessor", startReviewProcessor],
      ["incrementalIndexer", startIncrementalIndexer],
    ].map(([name, start]) =>
      (start as () => Promise<void>)().catch((err) => {
        logger.error("processor crashed", { processor: name, error: (err as Error).message });
        process.exit(1);
      })
    )
  );
}

/**
 * Graceful shutdown — disconnect consumers first (commits offsets and leaves
 * the group cleanly), then the shared producer.
 */
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("shutting down", { signal });
  try {
    stopWebhookOutboxSweeper();
    await disconnectConsumers();
    await disconnectProducer();
  } catch (err) {
    logger.error("error during shutdown", { error: String(err) });
  }
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

main().catch((err) => {
  logger.error("worker failed to start", { error: (err as Error).message });
  process.exit(1);
});
