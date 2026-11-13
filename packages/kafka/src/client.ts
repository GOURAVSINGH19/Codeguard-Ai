import { Kafka, logLevel } from "kafkajs";
import { ALL_TOPICS } from "./topics";

let kafkaInstance: Kafka | undefined;

/**
 * One Kafka client per process.
 * Short timeouts and few retries: a caller in the web app must never wait long
 * (GitHub gives the webhook 10 s). If Kafka is down, the outbox row stays
 * "received" and a sweeper publishes it later.
 */
export function kafka(): Kafka {
  if (!kafkaInstance) {
    const brokers = (process.env.KAFKA_BROKERS ?? "localhost:9092").split(",").map((b) => b.trim());
    kafkaInstance = new Kafka({
      clientId: process.env.KAFKA_CLIENT_ID ?? "codeguard",
      brokers,
      connectionTimeout: 3_000,
      requestTimeout: 10_000,
      retry: { retries: 2, initialRetryTime: 200 },
      logLevel: logLevel.WARN,
    });
  }
  return kafkaInstance;
}

/** Create every topic (and its DLQ) if missing. Workers call this at startup. */
export async function ensureTopics(numPartitions = 3): Promise<void> {
  const admin = kafka().admin();
  await admin.connect();
  try {
    const existing = new Set(await admin.listTopics());
    const missing = ALL_TOPICS.filter((t) => !existing.has(t));
    if (missing.length) {
      await admin.createTopics({
        topics: missing.map((topic) => ({ topic, numPartitions, replicationFactor: 1 })),
        waitForLeaders: true,
      });
    }
  } finally {
    await admin.disconnect();
  }
}
