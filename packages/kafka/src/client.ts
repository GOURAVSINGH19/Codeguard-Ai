import { Kafka, type Producer, type Consumer, logLevel } from "kafkajs";

let kafkaInstance: Kafka | null = null;

/**
 * Returns a singleton Kafka instance.
 * Reads broker config from environment variables:
 *
 *   KAFKA_BROKERS  — comma-separated list, e.g. "localhost:19092"
 *                    Defaults to "localhost:19092" for local Redpanda dev.
 *
 * For Upstash Kafka (production), set:
 *   KAFKA_BROKERS=<upstash-endpoint>:9092
 *   KAFKA_USERNAME=<upstash-username>
 *   KAFKA_PASSWORD=<upstash-password>
 */
export function getKafka(): Kafka {
  if (kafkaInstance) return kafkaInstance;

  const brokers = (process.env.KAFKA_BROKERS ?? "localhost:19092")
    .split(",")
    .map((b) => b.trim());

  const username = process.env.KAFKA_USERNAME;
  const password = process.env.KAFKA_PASSWORD;

  kafkaInstance = new Kafka({
    clientId: "codeguard-ai",
    brokers,
    // If credentials are present, enable SASL/SCRAM (required for Upstash)
    ...(username && password
      ? {
          ssl: true,
          sasl: {
            mechanism: "scram-sha-256",
            username,
            password,
          },
        }
      : {}),
    // Keep logs quiet in production; use DEBUG in dev via LOG_LEVEL env
    logLevel:
      process.env.LOG_LEVEL === "debug" ? logLevel.DEBUG : logLevel.WARN,
  });

  return kafkaInstance;
}

/**
 * Create a connected producer.
 * Caller is responsible for calling producer.disconnect() on shutdown.
 */
export async function createProducer(): Promise<Producer> {
  const producer = getKafka().producer({
    // Idempotent producer: guarantees exactly-once delivery per batch
    idempotent: true,
    // Require acks from all in-sync replicas before confirming
    transactionTimeout: 30_000,
  });
  await producer.connect();
  return producer;
}

/**
 * Create a connected consumer in the given consumer group.
 * Caller is responsible for calling consumer.disconnect() on shutdown.
 */
export async function createConsumer(groupId: string): Promise<Consumer> {
  const consumer = getKafka().consumer({
    groupId,
    // Retry up to 5 times with backoff before marking the message as failed
    retry: { retries: 5 },
  });
  await consumer.connect();
  return consumer;
}
