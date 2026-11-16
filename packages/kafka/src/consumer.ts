import { Partitioners, type Consumer, type KafkaMessage } from "kafkajs";
import type { z } from "zod";
import { kafka } from "./client";
import { dlq } from "./topics";

export interface ConsumeOptions<S extends z.ZodType> {
  topic: string;
  groupId: string;
  schema: S;
  handler: (event: z.output<S>) => Promise<void>;
  /** Attempts per message before it goes to the DLQ. */
  maxAttempts?: number;
  /** Messages processed at once across partitions (order is still kept per partition). */
  partitionsConsumedConcurrently?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Decide what to do with one message. Pure logic, exported for tests.
 *   bad JSON / wrong shape → DLQ immediately (retrying can't fix bad data)
 *   handler error          → retry with backoff, then DLQ
 * It never throws: a thrown error would make kafkajs redeliver the same
 * message forever and block its partition.
 */
export async function processMessage<S extends z.ZodType>(
  raw: string,
  opts: Pick<ConsumeOptions<S>, "schema" | "handler" | "maxAttempts">,
  deps: { toDlq: (reason: string) => Promise<void>; backoff?: (attempt: number) => Promise<void> },
): Promise<"ok" | "dlq"> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    await deps.toDlq("invalid JSON");
    return "dlq";
  }
  const parsed = opts.schema.safeParse(json);
  if (!parsed.success) {
    await deps.toDlq(`schema: ${parsed.error.message}`);
    return "dlq";
  }

  const max = opts.maxAttempts ?? 3;
  for (let attempt = 1; attempt <= max; attempt++) {
    try {
      await opts.handler(parsed.data);
      return "ok";
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (attempt === max) {
        await deps.toDlq(`failed after ${max} attempts: ${reason}`);
        return "dlq";
      }
      console.warn(`[kafka] attempt ${attempt}/${max} failed: ${reason}`);
      await (deps.backoff ?? ((a) => sleep(2 ** a * 500)))(attempt); // 1 s, 2 s, 4 s…
    }
  }
  return "dlq";
}

/** Subscribe and run `handler` for every message. Returns the consumer so the caller can disconnect it. */
export async function consume<S extends z.ZodType>(opts: ConsumeOptions<S>): Promise<Consumer> {
  const consumer = kafka().consumer({ groupId: opts.groupId });
  const producer = kafka().producer({ allowAutoTopicCreation: false, createPartitioner: Partitioners.DefaultPartitioner });
  await Promise.all([consumer.connect(), producer.connect()]);
  await consumer.subscribe({ topic: opts.topic, fromBeginning: false });

  const toDlq = (message: KafkaMessage) => async (reason: string) => {
    console.error(`[kafka] ${opts.topic} → DLQ: ${reason}`);
    await producer.send({
      topic: dlq(opts.topic),
      messages: [
        {
          key: message.key,
          value: message.value,
          headers: { "x-error": reason.slice(0, 1000), "x-original-topic": opts.topic },
        },
      ],
    });
  };

  await consumer.run({
    partitionsConsumedConcurrently: opts.partitionsConsumedConcurrently ?? 1,
    // When this resolves, kafkajs commits the offset: "done with this one".
    eachMessage: async ({ message }) => {
      await processMessage(message.value?.toString() ?? "", opts, { toDlq: toDlq(message) });
    },
  });

  consumer.on(consumer.events.CRASH, ({ payload }) => console.error("[kafka] consumer crashed:", payload.error));
  const disconnect = consumer.disconnect.bind(consumer);
  consumer.disconnect = async () => {
    await disconnect();
    await producer.disconnect();
  };
  return consumer;
}
