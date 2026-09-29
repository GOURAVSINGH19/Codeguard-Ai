import { getSharedProducer, disconnectSharedProducer } from "@codeguard/kafka";
import type { Producer } from "kafkajs";

/** The workers share one producer (also used for dead-letter writes). */
export function getWorkerProducer(): Promise<Producer> {
  return getSharedProducer();
}

export async function disconnectProducer(): Promise<void> {
  await disconnectSharedProducer();
}
