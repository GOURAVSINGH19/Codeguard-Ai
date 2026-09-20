import { createConsumer, createProducer } from "@codeguard/kafka";
import type { Consumer, Producer } from "kafkajs";

/**
 * Singleton consumer + producer for the workers app.
 *
 * Usage:
 *   const consumer = await getWorkerConsumer("my-group");
 *   const producer = await getWorkerProducer();
 */

let producer: Producer | null = null;

export async function getWorkerProducer(): Promise<Producer> {
  if (!producer) {
    producer = await createProducer();
  }
  return producer as Producer;
}

/** Always creates a fresh consumer — each job processor owns its own group */
export async function getWorkerConsumer(groupId: string): Promise<Consumer> {
  return createConsumer(groupId);
}

/** Gracefully disconnect all active clients — call on SIGTERM/SIGINT */
export async function disconnectAll(): Promise<void> {
  if (producer) {
    await producer.disconnect().catch(console.error);
    producer = null;
  }
}
