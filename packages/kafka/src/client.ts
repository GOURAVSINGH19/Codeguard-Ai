import { Kafka, type Producer, type Consumer, logLevel, type SASLOptions } from "kafkajs";
import { getKafkaConfig } from "@codeguard/config";
import { TOPICS } from "./topics";

let kafkaInstance: Kafka | null = null;

const LOG_LEVELS = {
  debug: logLevel.DEBUG,
  info: logLevel.INFO,
  warn: logLevel.WARN,
  error: logLevel.ERROR,
} as const;

export function getKafka(): Kafka {
  if (kafkaInstance) return kafkaInstance;

  const config = getKafkaConfig();

  kafkaInstance = new Kafka({
    clientId: "codeguard-ai",
    brokers: config.brokers,
    connectionTimeout: 4000,
    requestTimeout: 6000,
    retry: {
      retries: 2,
      initialRetryTime: 300,
    },
    // SASL (Upstash, Aiven, Confluent…) always runs over TLS with certificate
    // verification ON unless KAFKA_SSL_REJECT_UNAUTHORIZED=false is set.
    ssl: config.ssl,
    ...(config.sasl ? { sasl: config.sasl as SASLOptions } : {}),
    // Kafka's own logs stay quiet unless LOG_LEVEL=debug
    logLevel: config.logLevel === "debug" ? LOG_LEVELS.debug : LOG_LEVELS.warn,
  });

  return kafkaInstance;
}

/**
 * Create a connected producer.
 * Caller is responsible for calling producer.disconnect() on shutdown.
 */
export async function createProducer(): Promise<Producer> {
  const producer = getKafka().producer({
    // Idempotent producer: no duplicates from producer retries
    idempotent: true,
    transactionTimeout: 30_000,
  });
  await producer.connect();
  return producer;
}

let sharedProducer: Promise<Producer> | null = null;

/**
 * One long-lived producer per process (serverless instance or worker).
 * Creating and tearing down a producer per request costs a full broker
 * handshake; reusing it keeps webhook latency low. If connecting fails the
 * cached promise is cleared so the next call retries.
 */
export function getSharedProducer(): Promise<Producer> {
  if (!sharedProducer) {
    sharedProducer = createProducer().catch((err) => {
      sharedProducer = null;
      throw err;
    });
  }
  return sharedProducer;
}

export async function disconnectSharedProducer(): Promise<void> {
  if (!sharedProducer) return;
  const pending = sharedProducer;
  sharedProducer = null;
  await (await pending).disconnect().catch(() => {});
}

/**
 * Create a connected consumer in the given consumer group.
 * Caller is responsible for calling consumer.disconnect() on shutdown.
 */
export async function createConsumer(groupId: string): Promise<Consumer> {
  const consumer = getKafka().consumer({
    groupId,
    retry: { retries: 5 },
  });
  await consumer.connect();
  return consumer;
}

/**
 * Ensures all required CodeGuard Kafka topics (including dead-letter topics)
 * exist in the broker. Creates any that are missing.
 */
export async function ensureTopicsExist(): Promise<void> {
  const admin = getKafka().admin();
  try {
    await admin.connect();
    const existingTopics = await admin.listTopics();
    const topicsToCreate = Object.values(TOPICS).filter((topic) => !existingTopics.includes(topic));

    if (topicsToCreate.length > 0) {
      console.log(`[kafka] Auto-creating missing topics: ${topicsToCreate.join(", ")}`);
      await admin.createTopics({
        topics: topicsToCreate.map((topic) => ({
          topic,
          // Several partitions so different PRs are processed in parallel while
          // messages for the same PR (same key) stay ordered.
          numPartitions: topic.endsWith(".dlq") ? 1 : 3,
          replicationFactor: 1,
        })),
      });
    }
  } catch (err) {
    console.warn("[kafka] Topic check warning:", (err as Error).message);
  } finally {
    await admin.disconnect().catch(() => {});
  }
}
