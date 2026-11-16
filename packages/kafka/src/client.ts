import { Kafka, logLevel, type KafkaConfig, type SASLOptions } from "kafkajs";
import { ALL_TOPICS } from "./topics";

let kafkaInstance: Kafka | undefined;

const pem = (v: string | undefined) => (v ? v.replace(/\\n/g, "\n") : undefined);

/**
 * Security settings for hosted Kafka (Aiven, Confluent, Redpanda…). Local Docker needs none.
 *   KAFKA_SASL_USERNAME + KAFKA_SASL_PASSWORD (+ KAFKA_SASL_MECHANISM, default scram-sha-256) → SASL over TLS
 *   KAFKA_CLIENT_CERT + KAFKA_CLIENT_KEY                                                   → TLS client certificate
 *   KAFKA_CA_CERT    the provider's CA certificate (PEM, newlines as \n)
 *   KAFKA_SSL=true   TLS without either of the above
 */
export function securityFromEnv(env: NodeJS.ProcessEnv = process.env): Pick<KafkaConfig, "ssl" | "sasl"> {
  const ca = pem(env.KAFKA_CA_CERT);
  const cert = pem(env.KAFKA_CLIENT_CERT);
  const key = pem(env.KAFKA_CLIENT_KEY);
  const useSasl = !!(env.KAFKA_SASL_USERNAME && env.KAFKA_SASL_PASSWORD);
  const useTls = useSasl || !!(cert && key) || !!ca || env.KAFKA_SSL === "true";
  if (!useTls) return {};

  const ssl = ca || (cert && key) ? { rejectUnauthorized: true, ...(ca ? { ca: [ca] } : {}), ...(cert && key ? { cert, key } : {}) } : true;
  if (!useSasl) return { ssl };

  const mechanism = (env.KAFKA_SASL_MECHANISM ?? "scram-sha-256").toLowerCase() as "plain" | "scram-sha-256" | "scram-sha-512";
  const sasl = { mechanism, username: env.KAFKA_SASL_USERNAME!, password: env.KAFKA_SASL_PASSWORD! } as SASLOptions;
  return { ssl, sasl };
}

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
      ...securityFromEnv(),
      connectionTimeout: 5_000,
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
