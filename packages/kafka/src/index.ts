export {
  getKafka,
  createProducer,
  createConsumer,
  ensureTopicsExist,
  getSharedProducer,
  disconnectSharedProducer,
} from "./client";
export { sendToDeadLetter, deadLetterTopicFor, prMessageKey } from "./dlq";
export { TOPICS } from "./topics";
export type { TopicName } from "./topics";
export {
  WebhookReceivedEventSchema,
  ReviewRequestedEventSchema,
  ReviewCompletedEventSchema,
  GitHubPushEventSchema,
  IndexIncrementalEventSchema,
  DeadLetterEventSchema,
} from "./schemas";
export type {
  WebhookReceivedEvent,
  ReviewRequestedEvent,
  ReviewCompletedEvent,
  GitHubPushEvent,
  IndexIncrementalEvent,
  DeadLetterEvent,
} from "./schemas";
