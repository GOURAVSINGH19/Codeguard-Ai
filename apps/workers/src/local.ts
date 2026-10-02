/**
 * Local-Kafka entrypoint: `pnpm --filter workers dev:local`.
 *
 * Runs the workers against the docker-compose Redpanda instead of the hosted
 * Kafka configured in `.env`. Vercel cannot reach this broker, so its webhook
 * publishes fail — but every delivery is already stored in `webhook_events`
 * with status "received", and the outbox sweeper republishes those rows into
 * this broker within a few seconds. Everything else (DB, GitHub, AI keys) still
 * comes from `.env`.
 *
 * Set before `.env` loads: dotenv never overrides variables that already exist.
 */
process.env.KAFKA_BROKERS = process.env.LOCAL_KAFKA_BROKERS ?? "localhost:19092";
// Empty values count as unset in @codeguard/config, which turns SASL/TLS off.
process.env.KAFKA_HOST = "";
process.env.KAFKA_USERNAME = "";
process.env.KAFKA_PASSWORD = "";
// Every event arrives through the outbox here, so sweep every few seconds.
process.env.OUTBOX_SWEEP_INTERVAL_MS ??= "5000";

await import("./index.js");

export {};
