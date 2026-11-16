# Step 3: Kafka, the message highway

> **In one line:** Kafka carries jobs from the web app to the workers. It keeps each PR's events in order, buffers spikes, and parks broken messages in a dead-letter topic instead of getting stuck.

⬅ [Step 2](02-receive-webhook.md) · Next ➡ [Step 4: Route the event](04-route-event.md)

---

## 1. How this step begins

The moment the webhook handler publishes a message, Kafka holds it until a worker reads it. When the workers start ([index.ts](../../apps/workers/src/index.ts)), they create the topics if missing and start one **consumer** per job type.

```
codeguard.webhook.received   →  webhookProcessor     (decides what the event means)
codeguard.review.requested   →  reviewProcessor      (runs the AI review)
codeguard.review.completed   →  (no consumer yet; a hook for notifications)
codeguard.index.full         →  fullIndexer          (index a whole repo)
codeguard.index.incremental  →  incrementalIndexer   (re-index changed files)
every consumed topic has a  .dlq  partner (dead-letter queue)
```

## 2. What is important

**Kafka words, in plain English:**

| Word | Simple meaning |
|---|---|
| Topic | A named stream of messages, like a folder |
| Partition | A topic is split into ordered lanes. Order is only guaranteed inside one lane |
| Key | Decides the lane. Same key → same lane → same order |
| Consumer group | A team of workers sharing the lanes; each lane goes to one worker |
| Offset | A bookmark: "I've read up to here" |
| DLQ | Dead-letter queue: a parking lot for messages that can't be processed |
| At-least-once | A message is never lost, but may arrive twice |

**How CodeGuard uses it:**

- **Key = `owner/repo#number`.** Three quick pushes to one PR are processed in order; different PRs run in parallel.
- **One wrapper for every consumer** ([consumer.ts](../../apps/workers/src/queue/consumer.ts)), so they all behave the same:
  1. Parse JSON and validate with **Zod**. Invalid → straight to the DLQ (retrying can't fix bad data).
  2. Run the handler. If it throws, retry up to **3 attempts** with exponential backoff, then send it to the DLQ. One "poison" message can't block a lane forever.
  3. **Heartbeat every 3 s** while the handler runs. Without it, Kafka thinks a worker busy with a slow AI call is dead and hands the same message to another worker.
- **Idempotent producer** and one shared producer per process.
- **Graceful shutdown:** consumers disconnect first, so their bookmarks (offsets) are saved.

## 3. Why we use this

| Need | How Kafka helps |
|---|---|
| Web answers in milliseconds, work takes minutes | Producer and consumer are decoupled |
| A burst of 500 PRs | Messages wait in Kafka; nothing crashes |
| Pushes to the same PR must not overtake each other | Per-key ordering |
| Debugging or re-processing | Messages are kept for a while and can be replayed |

**Honest trade-off:** at this size, SQS, BullMQ or a Postgres-backed queue would also work and be simpler. Kafka was chosen for per-key ordering and replay, and to learn partitions, consumer groups and DLQs properly.

Because delivery is **at-least-once**, every consumer must be **idempotent** (safe to run twice). See [Step 6](06-claim-review.md).

## What can go wrong

| Situation | What happens |
|---|---|
| A message keeps crashing the worker | After 3 attempts → DLQ with the error attached; the lane moves on |
| Malformed message | Zod fails → DLQ immediately |
| Worker dies mid-message | Offset not saved → Kafka gives it to another worker; the claim in Step 6 stops double work |
| AI call takes 2 minutes | Heartbeats keep the worker's session alive |

## Code to read

- [topics.ts](../../packages/kafka/src/topics.ts), [schemas.ts](../../packages/kafka/src/schemas.ts), [client.ts](../../packages/kafka/src/client.ts), [dlq.ts](../../packages/kafka/src/dlq.ts)
- [consumer.ts](../../apps/workers/src/queue/consumer.ts) and its [test](../../apps/workers/src/queue/__tests__/consumer.test.ts)
