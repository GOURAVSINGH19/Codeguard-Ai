import { Kafka, type Producer, type Consumer, logLevel } from "kafkajs";

let kafkaInstance: Kafka | null = null;

export function getKafka(): Kafka {
  if (kafkaInstance) return kafkaInstance;

  let brokers: string[] = [];

  if (process.env.KAFKA_BROKERS) {
    brokers = process.env.KAFKA_BROKERS.split(",")
      .map((b) => b.trim())
      .filter(Boolean);
  } else if (process.env.KAFKA_HOST) {
    const host = process.env.KAFKA_HOST.trim();
    const port = process.env.KAFKA_PORT ? process.env.KAFKA_PORT.trim() : "9092";
    brokers = [`${host}:${port}`];
  } else {
    brokers = ["localhost:19092"];
  }

  const username = process.env.KAFKA_USERNAME?.trim();
  const password = process.env.KAFKA_PASSWORD?.trim();

  kafkaInstance = new Kafka({
    clientId: "codeguard-ai",
    brokers,
    // If credentials are present, enable SASL/SCRAM (required for cloud Kafka like Upstash or Aiven)
    ...(username && password
      ? {
        ssl: process.env.KAFKA_SSL === "false" ? false : true,
        sasl: {
          mechanism: (process.env.KAFKA_SASL_MECHANISM?.trim() as any) || "scram-sha-256",
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
