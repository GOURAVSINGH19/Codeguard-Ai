import type { Producer } from "kafkajs";
import type { DeadLetterEvent } from "./schemas";

/** Topic used for a source topic's dead letters: "<topic>.dlq". */
export function deadLetterTopicFor(topic: string): string {
  return `${topic}.dlq`;
}

/**
 * Park a message that could not be processed. Never throws: if the DLQ write
 * itself fails we log loudly and let the caller continue, so one bad message
 * can never block its partition.
 */
export async function sendToDeadLetter(
  producer: Producer,
  input: { topic: string; key: string | null; value: string | null; error: unknown; attempts: number }
): Promise<void> {
  const event: DeadLetterEvent = {
    sourceTopic: input.topic,
    originalKey: input.key,
    originalValue: input.value,
    error: input.error instanceof Error ? `${input.error.name}: ${input.error.message}` : String(input.error),
    attempts: input.attempts,
    failedAt: new Date().toISOString(),
  };
  try {
    await producer.send({
      topic: deadLetterTopicFor(input.topic),
      messages: [{ key: input.key ?? undefined, value: JSON.stringify(event) }],
    });
  } catch (err) {
    console.error(`[kafka] FAILED to write to DLQ for ${input.topic}:`, (err as Error).message, event);
  }
}

/** PR-scoped message key so every event for one PR lands on one partition, in order. */
export function prMessageKey(owner: string, repo: string, pullNumber: number): string {
  return `${owner}/${repo}#${pullNumber}`.toLowerCase();
}
