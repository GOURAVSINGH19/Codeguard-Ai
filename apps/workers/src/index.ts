import "dotenv/config";
import { startWebhookProcessor } from "./jobs/webhookProcessor.js";
import { startReviewProcessor } from "./jobs/reviewProcessor.js";
import { startIncrementalIndexer } from "./jobs/incrementalIndexer.js";
import { disconnectAll } from "./queue/kafkaClient.js";

// Export indexRepository so it can be run directly:
//   npx tsx src/index.ts index <owner> <repo> <repositoryId>
export { indexRepository } from "./jobs/indexRepository.js";
export { startIncrementalIndexer } from "./jobs/incrementalIndexer.js";

console.log("🚀 CodeGuard AI Workers starting...");
console.log(`   Kafka brokers: ${process.env.KAFKA_BROKERS ?? "localhost:19092"}`);
console.log(`   AI model:      ${process.env.GROQ_MODEL ?? "openai/gpt-oss-120b"}`);
console.log("");

/**
 * Start all consumer workers concurrently.
 * Each processor runs an infinite consumer loop — they do not resolve.
 */
async function main() {
  await Promise.all([
    startWebhookProcessor().catch((err) => {
      console.error("[main] webhookProcessor crashed:", err);
      process.exit(1);
    }),
    startReviewProcessor().catch((err) => {
      console.error("[main] reviewProcessor crashed:", err);
      process.exit(1);
    }),
    startIncrementalIndexer().catch((err) => {
      console.error("[main] incrementalIndexer crashed:", err);
      process.exit(1);
    }),
  ]);
}

/**
 * Graceful shutdown — disconnect Kafka clients before the process exits.
 * This ensures in-flight messages are committed and no offsets are lost.
 */
async function shutdown(signal: string) {
  console.log(`\n[main] Received ${signal} — shutting down gracefully...`);
  try {
    await disconnectAll();
    console.log("[main] Kafka clients disconnected. Goodbye.");
  } catch (err) {
    console.error("[main] Error during shutdown:", err);
  }
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

main();
