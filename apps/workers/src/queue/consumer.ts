import type { Consumer, EachMessagePayload } from "kafkajs";
import type { z } from "zod";
import { createConsumer, sendToDeadLetter } from "@codeguard/kafka";
import { getWorkerProducer } from "./kafkaClient.js";
import { logger } from "../lib/logger.js";

const consumers = new Set<Consumer>();

export class PermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentError";
  }
}

export interface ConsumerSpec<S extends z.ZodTypeAny> {
  name: string;
  groupId: string;
  topic: string;
  schema: S;
  handler: (event: z.infer<S>, ctx: { key: string | null; heartbeat: () => Promise<void> }) => Promise<void>;
  /** Total attempts before the message goes to the DLQ (default 3). */
  maxAttempts?: number;
}

/**
 * Run a Kafka consumer with the guarantees every processor needs:
 *  - invalid JSON / schema → dead-letter topic immediately (never crashes the loop)
 *  - handler errors → retried with backoff, then dead-lettered
 *  - heartbeats while a slow handler (LLM call) runs, so the group doesn't rebalance
 */
export async function runConsumer<S extends z.ZodTypeAny>(spec: ConsumerSpec<S>): Promise<void> {
  const consumer = await createConsumer(spec.groupId);
  consumers.add(consumer);
  const producer = await getWorkerProducer();
  const maxAttempts = spec.maxAttempts ?? 3;
  const log = logger.child({ consumer: spec.name });

  await consumer.subscribe({ topic: spec.topic, fromBeginning: false });
  log.info("listening", { topic: spec.topic });

  await consumer.run({
    eachMessage: async ({ message, heartbeat }: EachMessagePayload) => {
      const key = message.key?.toString() ?? null;
      const raw = message.value?.toString() ?? null;
      const dlq = (error: unknown, attempts: number) =>
        sendToDeadLetter(producer, { topic: spec.topic, key, value: raw, error, attempts });

      if (!raw) return;

      let event: z.infer<S>;
      try {
        const parsed = spec.schema.safeParse(JSON.parse(raw));
        if (!parsed.success) throw new PermanentError(`schema: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
        event = parsed.data;
      } catch (err) {
        log.warn("invalid message sent to DLQ", { key, error: (err as Error).message });
        await dlq(err, 0);
        return;
      }

      const beat = setInterval(() => heartbeat().catch(() => {}), 3_000);
      try {
        for (let attempt = 1; ; attempt++) {
          try {
            await spec.handler(event, { key, heartbeat });
            return;
          } catch (err) {
            const permanent = err instanceof PermanentError;
            if (permanent || attempt >= maxAttempts) {
              log.error("message failed, sent to DLQ", { key, attempt, error: (err as Error).message });
              await dlq(err, attempt);
              return;
            }
            const delay = Math.min(30_000, 1_000 * 2 ** attempt);
            log.warn("handler failed, retrying", { key, attempt, delayMs: delay, error: (err as Error).message });
            await new Promise((r) => setTimeout(r, delay));
          }
        }
      } finally {
        clearInterval(beat);
      }
    },
  });
}

/** Disconnect every consumer so offsets are committed before exit. */
export async function disconnectConsumers(): Promise<void> {
  await Promise.all([...consumers].map((c) => c.disconnect().catch((err) => logger.error("consumer disconnect failed", { error: String(err) }))));
  consumers.clear();
}
