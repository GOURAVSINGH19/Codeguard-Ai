import { Partitioners, type Producer } from "kafkajs";
import type { z } from "zod";
import { kafka } from "./client";

let producer: Producer | undefined;
let connecting: Promise<void> | undefined;

async function getProducer(): Promise<Producer> {
  if (!producer) {
    producer = kafka().producer({ allowAutoTopicCreation: false, createPartitioner: Partitioners.DefaultPartitioner });
    connecting = producer.connect().catch((err) => {
      // Reset so the next call tries again instead of reusing a failed connection.
      producer = undefined;
      connecting = undefined;
      throw err;
    });
  }
  await connecting;
  return producer!;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

/**
 * Validate, then send. Bad data never enters the log.
 * `timeoutMs` caps how long a caller waits (the webhook route uses a short one).
 */
export async function publish<S extends z.ZodType>(
  topic: string,
  key: string,
  schema: S,
  event: z.input<S>,
  { timeoutMs = 5_000 }: { timeoutMs?: number } = {},
): Promise<void> {
  const value = schema.parse(event);
  await withTimeout(
    getProducer().then((p) => p.send({ topic, messages: [{ key, value: JSON.stringify(value) }] })),
    timeoutMs,
    `publish to ${topic}`,
  );
}

export async function disconnectProducer(): Promise<void> {
  const p = producer;
  producer = undefined;
  connecting = undefined;
  await p?.disconnect();
}
