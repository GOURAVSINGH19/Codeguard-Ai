# Step 6: Claim the review (no duplicates)

> **In one line:** before doing any work, the review worker **claims** the review row for (PR, head commit, requester) in Postgres. If another healthy worker already owns it, this worker quietly stops.

⬅ [Step 5](05-index-code.md) · Next ➡ [Step 7: Prepare the context](07-prepare-context.md)

---

## 1. How this step begins

A message arrives on `codeguard.review.requested` (from the router in [Step 4](04-route-event.md), or from a user clicking **Review** on the dashboard). The first pipeline node, `initialize_run`, calls `claimReview`:

```
INSERT review (status = in_progress)
   ├─ success  → I own it → run the pipeline
   └─ conflict (unique index says someone has it)
         ↓
      UPDATE … SET in_progress
      WHERE same PR + commit + user
        AND (status = pending
             OR (status = in_progress AND not touched for 15 minutes))
         ├─ 1 row  → I took over a queued or dead run
         └─ 0 rows → someone alive is on it → stop
```

## 2. What is important

- **Postgres is the referee.** A **partial unique index** on `reviews(pull_request_id, head_sha, coalesce(user_id, ''))` makes the database reject a second live review of the same commit.
  - *Partial:* the index only covers rows that are **not failed**, so a failed review never blocks a retry.
  - *`coalesce(user_id, '')`:* in SQL, `NULL` never equals `NULL`. Without this, two bot reviews (no user) would never collide.
- **Liveness heartbeat.** Every pipeline node updates the row's `updated_at` (and its progress). A row untouched for **15 minutes** is considered dead and can be taken over.
- **Incremental reviews.** On a new commit, the review compares against the **last commit actually reviewed**, so only new changes are shown to the AI.

## 3. Why we use this

Kafka delivers **at least once**, sweepers republish, and users double-click. Without a claim we would pay for the same AI review twice and post the same comments twice. Letting the database decide is simple and correct even with many workers.

## What can go wrong

| Situation | What happens |
|---|---|
| Two workers get the same message at once | Only one INSERT wins; the other's UPDATE changes 0 rows |
| Worker crashes mid-review | No heartbeat → after 15 min the recovery sweeper or a new claim takes it over |
| Review failed, user retries | Failed rows are outside the index, so a new row is allowed |
| Dashboard review and bot review of the same commit | Different requester → both allowed, by design |

## Code to read

- [store.ts](../../apps/workers/src/pipeline/store.ts) (`claimReview`, `STALE_REVIEW_MS`)
- [reviews.ts](../../packages/db/schema/reviews.ts) (the partial unique index)
- Migration: [0002_idempotency_and_install_owner.sql](../../packages/db/migrations/0002_idempotency_and_install_owner.sql)
