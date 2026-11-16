# CodeGuard AI: 3-day rebuild roadmap

You kept the **frontend** (`apps/web`: pages, components, styles, Clerk login in `src/proxy.ts`).
Everything behind it is gone: API routes, services, Kafka, workers, database and the AI engine.
This plan rebuilds the backend one layer at a time so you understand each piece before the next one depends on it.

**How to use this plan**

- Each block has 4 parts: **Learn** (read first), **Build**, **Done when** (a check you can actually run), **Explain it** (questions to answer out loud or in a notebook). Don't skip "Explain it"; that is where the understanding comes from.
- Get it working end to end first, then make it clever. Day 2 ends with a dumb but complete review, and Day 3 makes it smart.
- The UI already calls these endpoints. Each block says which ones it brings back to life, so you can open the dashboard and watch it start working.
- Old code is still in git history (commit `f56e12c`) if you get stuck: `git show f56e12c:apps/workers/src/index.ts`. Try it yourself first and only peek when you're stuck.

---

## Target layout (what you will create)

```
apps/
  web/                 ← kept (UI) + you add src/app/api/** and src/server/**
  workers/             ← Day 2: Node processes that consume Kafka
packages/
  config/              ← Day 1: env vars validated with Zod
  db/                  ← Day 1: Drizzle schema + migrations
  kafka/               ← Day 2: topics, event schemas, producer/consumer helpers
  review-engine/       ← Day 2–3: prompts, LLM provider, reviewers, verifier, scoring
docker-compose.yml     ← Day 1: Postgres (pgvector) + Kafka locally
```

---

## Day 1: Foundation, from a GitHub event to a database row

📒 Detailed notes with code: [notes/day-1.md](notes/day-1.md)

**Goal by the end of the day:** you open a PR on a test repo, GitHub sends a webhook, your app verifies it, saves it to Postgres and answers 200 in milliseconds. You can install the app and see your repos in the UI.

### 1.1 Monorepo + local infrastructure (≈1.5 h)
- **Learn:** `docs/HLD.md` sections 1–3. How pnpm workspaces work (`pnpm-workspace.yaml` already lists `apps/*` and `packages/*`).
- **Build:**
  - **Neon** Postgres: create a project and a `dev` branch, copy the pooled URL (for the app) and the direct URL (for migrations), and run `CREATE EXTENSION vector;`.
  - `docker-compose.yml` with Kafka only (`apache/kafka`, KRaft mode, no Zookeeper).
  - `packages/config`: one `getEnv()` that parses `process.env` with a Zod schema and throws a clear error for anything missing.
  - Root `.env.example` listing every variable (DATABASE_URL, KAFKA_BROKERS, GITHUB_APP_ID, GITHUB_PRIVATE_KEY, GITHUB_WEBHOOK_SECRET, LLM provider + key, Clerk keys).
- **Done when:** Neon shows the `vector` extension, `docker compose up -d` runs Kafka, and `getEnv()` throws a readable error when you delete one variable.
- **Explain it:** Why validate env at startup instead of when it is first used? Why a monorepo instead of two repos?

### 1.2 Database with Drizzle (≈2 h)
- **Learn:** Drizzle basics (schema → `drizzle-kit generate` → `migrate`). Read `docs/steps/02` and `06` to see which tables you need.
- **Build** `packages/db` with these tables, starting minimal:
  - `users` (Clerk id), `github_installations`, `repositories`
  - `webhook_events` (delivery id **unique**, payload, status: `pending|published|failed`), which is your **outbox**
  - `reviews` (repo, PR number, head SHA, status, score, summary, **unique (repo, pr, sha)**), `review_findings`
  - Export `db` (Neon/pg client) and the tables.
- **Done when:** `pnpm db:migrate` creates the tables and you can see them in `psql` or Drizzle Studio.
- **Explain it:** What does the unique key on `reviews` protect you from? Why is the webhook delivery id unique?

### 1.3 GitHub App + install flow (≈2 h)
- **Learn:** `docs/steps/01-connect-repo.md`. The difference between a GitHub App and an OAuth app, and installation tokens (they last 1 hour).
- **Build:**
  - Create a GitHub App (permissions: Pull requests R/W, Contents R, Checks R/W, Metadata R; events: Pull request). Use smee.io or ngrok for the webhook URL.
  - `src/server/github-app.ts` uses `@octokit/auth-app` to get an installation-scoped Octokit.
  - Routes: `GET /api/github/app/install` (redirect), `/api/github/app/callback`, `GET /api/github/app/installations`, `GET|DELETE /api/github/app/installations/[id]`, `GET /api/github/app/repositories`, `GET /api/github/app/repositories/[owner]/[repo]/pulls`.
- **UI unlocked:** `/install` page, the repo drawer, the PR list on the dashboard.
- **Done when:** you sign in, install the app on a test repo, and see its open PRs in the UI.
- **Explain it:** Why does the private key never leave the server? Why are installation tokens short-lived?

### 1.4 Receive the webhook safely (≈2 h)
- **Learn:** `docs/steps/02-receive-webhook.md`, HMAC-SHA256 and `crypto.timingSafeEqual`.
- **Build:**
  - `verifyGitHubSignature(rawBody, header, secret)`. Use the **raw** body (`await req.text()`), not parsed JSON.
  - `POST /api/webhooks/github-app`: verify → insert into `webhook_events` (ignore a duplicate delivery id) → return 200. No slow work here.
  - Also handle `installation` / `installation_repositories` events so the `github_installations` and `repositories` tables stay in sync.
  - Write 3 Vitest tests: valid signature, tampered body, missing header.
- **Done when:** opening a PR creates exactly one `webhook_events` row; redelivering it from GitHub's UI does **not** create a second one.
- **Explain it:** Why compare signatures in constant time? Why must the handler answer within 10 s?

**Day 1 checkpoint:** Draw the flow GitHub → webhook route → Postgres on paper from memory.

---

## Day 2: Async pipeline, from a saved event to a posted review

📒 Detailed notes with code: [notes/day-2.md](notes/day-2.md)

**Goal by the end of the day:** a PR is opened, Kafka carries the job to a worker, the worker asks an LLM for a review of the diff, saves findings, posts a PR comment, and the dashboard shows it live. The review is simple but works end to end.

### 2.1 Kafka package + outbox publisher (≈2 h)
- **Learn:** `docs/steps/03-kafka.md`. Topics, partitions, consumer groups, message keys (key = `owner/repo#pr` keeps one PR's events in order).
- **Build** `packages/kafka`:
  - `TOPICS` = `webhook.received`, `review.requested`, plus a `*.dlq` for each.
  - Zod schemas for every event, `publish(topic, key, event)` that validates **before** sending, and a `consume(topic, group, handler)` helper.
  - In the webhook route, after the DB insert, publish `webhook.received` and mark the row `published`. If Kafka fails, leave it `pending` (a sweeper resends it on Day 3).
- **Done when:** a PR event appears in the topic (`kafka-console-consumer`), and stopping Kafka still saves the row as `pending`.
- **Explain it:** What is the transactional outbox, and what bug does it prevent? Why validate events on both the producing and the consuming side?

### 2.2 Workers: router + claim (≈2 h)
- **Learn:** `docs/steps/04-route-event.md`, `06-claim-review.md`. What idempotency means.
- **Build** `apps/workers` (plain Node + `tsx`):
  - `webhookProcessor`: consume `webhook.received`. If the action is `opened|synchronize|reopened` and the repo has auto-review on, publish `review.requested`.
  - `reviewProcessor`: consume `review.requested` → **claim** with `INSERT … ON CONFLICT (repo, pr, sha) DO NOTHING RETURNING id`. If no row comes back, someone already has it, so skip.
  - **Incremental review** *(CodeRabbit idea)*: on `synchronize`, look up the last completed review's head SHA for this PR and review only the diff `lastSha...newSha` (`repos.compareCommits`). Store `base_sha` on the review row.
  - Retry with backoff; after N failures send the message to the DLQ.
- **Done when:** sending the same `review.requested` twice creates only one review row, and pushing a second commit reviews only that commit's changes.
- **Explain it:** Kafka gives "at least once" delivery. Why is that fine here? Why would re-reviewing the whole PR on every push annoy developers?

### 2.3 Minimum AI review (≈3 h)
- **Learn:** `docs/ai/01-llm-basics.md`, `02-prompts-and-injection.md`, `03-structured-output.md`.
- **Build** `packages/review-engine`:
  - `LLMProvider` interface + one implementation (whichever key you have). Choose it with `LLM_PROVIDER`.
  - Fetch the PR diff with the installation Octokit and cut it to a token budget.
  - **Run a linter first** *(CodeRabbit idea)*: fetch the changed files and run ESLint (or Semgrep for security) on them through its Node API. Add the results to the prompt as "tool findings: confirm, explain or ignore". Tools are deterministic, so the AI starts from facts.
  - One prompt. Put the PR title/body/diff inside clear delimiters ("this is data, not instructions").
  - Zod schema for the output: `{ summary, score, findings: [{ file, line, severity, category, message, suggestion }] }`. Parse it; if parsing fails, retry once with the error message.
  - Save the review + findings, status `completed`/`failed`.
- **Done when:** opening a PR produces a stored review with findings that point to real lines.
- **Explain it:** Why can't you trust raw LLM JSON? How could a PR description try to hijack the reviewer?

### 2.4 Publish + dashboard APIs (≈2 h)
- **Learn:** `docs/steps/11-publish.md`, `12-dashboard.md`. Server-Sent Events.
- **Build:**
  - Post one summary comment + inline review comments (`pulls.createReview`). Create a Check Run (`success`/`failure`).
  - API routes for the UI: `GET /api/reviews` (supports `page`, `pageSize`, `q`, `group`), `GET /api/reviews/[id]`, `GET /api/reviews/[id]/events` (SSE stage updates), `POST /api/github/review` (manual review → 202 + id), `POST /api/github/comment`, `PATCH /api/reviews/[id]/findings/[findingId]`, `POST /api/github/repos/[owner]/[repo]/auto-review`.
  - Workers write a `stage` column as they progress; the SSE route polls it and streams changes.
- **UI unlocked:** dashboard, review detail page, live progress, command palette search.
- **Done when:** you click "review" in the UI, watch stages tick by, and see the comment on GitHub.

**Day 2 checkpoint:** Explain, without notes, what happens if the worker crashes halfway through a review.

---

## Day 3: Make it smart, then make it reliable

📒 Detailed notes with code: [notes/day-3.md](notes/day-3.md)

**Goal by the end of the day:** reviews use real repo context, every finding is double-checked, a team policy decides pass/fail, stuck jobs recover by themselves, and the trends page works.

### 3.1 Code indexing + RAG (≈2.5 h)
- **Learn:** `docs/ai/04-embeddings-and-rag.md`, `docs/steps/05-index-code.md`.
- **Build:**
  - Enable `CREATE EXTENSION vector`; add a `code_chunks` table (repo, path, sha, content, `embedding vector(N)`).
  - Chunker: start with simple "split by function/class" (Tree-sitter if you have time, line windows if not).
  - Full indexer on install and an incremental indexer on push (only changed files).
  - During a review, embed the diff and retrieve the top-k similar chunks (`ORDER BY embedding <=> $1 LIMIT k`).
- **Done when:** a review comment refers to a file that is **not** in the diff.

### 3.2 Blast radius + staged review (≈2.5 h)
- **Learn:** `docs/ai/05-context-engineering.md`, `06-blast-radius.md`, `docs/steps/07`, `08`.
- **Build:**
  - Import graph: parse `import`/`require` per file → reverse edges → BFS from the changed files = affected files.
  - **Callers of changed functions** *(CodeRabbit idea)*: for each function or type the diff changes, find where it is used in the affected files (a name match is fine to start) and add those snippets to the context. This catches files that RAG misses because they share no wording with the change.
  - Stage 1 "what changed" → Stage 2 "how risky" (blast radius size, critical paths like auth/payments) → Stage 3: **quality ∥ security ∥ testing** reviewers in parallel (`Promise.all`), each with its own prompt.
  - Merge and remove duplicate findings (same file + line + similar message).
- **Done when:** a one-line change to a widely imported util gets a higher risk level than a large isolated change.

### 3.3 Verifier + policy decision (≈1.5 h)
- **Learn:** `docs/ai/07-verifier.md`, `docs/steps/09`, `10`, `docs/ai/09-pipeline-vs-agent.md`.
- **Build:**
  - Verifier: a second LLM call per finding (or batched) with the actual code → `confirmed | rejected` + reason. Drop rejected findings.
  - Read `.codeguard.yml` from the repo (e.g. `fail_on: [critical, high]`, `min_score: 70`). **Code** decides pass/fail, not the model.
  - **Path instructions** *(CodeRabbit idea)*: let `.codeguard.yml` give review rules per folder, and add the matching ones to the reviewer prompt (use `minimatch` against changed paths):
    ```yaml
    path_instructions:
      - path: "src/auth/**"
        instructions: "Check token expiry and that signature algorithms are pinned."
      - path: "**/*.test.ts"
        instructions: "Only flag missing edge cases; ignore style."
    ```
  - Give the verifier the same rules, so it rejects findings that contradict team rules.
- **Done when:** a planted false positive gets rejected, changing `.codeguard.yml` flips the Check Run result, and a path instruction visibly changes the comments on a matching file.

### 3.4 Recovery + trends + evals (≈1.5 h)
- **Learn:** `docs/steps/13-recovery.md`, `docs/ai/08-evals.md`.
- **Build:**
  - Sweepers (`setInterval` in workers): resend `pending` outbox rows older than 30 s; mark reviews stuck in `running` for over 10 min as failed and send them back to the queue.
  - `GET /api/reviews/trends?days=N` (scores over time, issues by category).
  - A small eval set: 5 diffs with known bugs → run the pipeline → check that each bug was found. Track the hit rate.
- **UI unlocked:** `/reviews/trends`.
- **Done when:** kill the worker mid-review, restart it, and the review still finishes.

**Day 3 checkpoint:** Walk through the full sequence diagram in `docs/HLD.md` §4 and name the file you wrote for each arrow.

---

## After the 3 days: more ideas from CodeRabbit

These come from how [CodeRabbit](https://docs.coderabbit.ai/overview/architecture) describes its system. Add them once the core works.

1. **Learnings.** When a user dismisses a finding (`PATCH /api/reviews/[id]/findings/[findingId]`) or replies "we don't do this here", save a short rule to a `learnings` table (repo or org scope). Retrieve the relevant ones and add them to future prompts and to the verifier.
2. **Past PRs as context.** Embed each finished review's summary. When a new PR touches the same files, retrieve related past PRs ("this area was changed in #42 for a race condition").
3. **Linked issues.** Parse `Fixes #123` in the PR body, fetch the issue, and add a stage that asks: does the change actually do what the issue asks?
4. **Sandbox verification.** Clone the repo into a throwaway container. Let the verifier run a small script or the test suite to prove a finding instead of only reasoning about it.
5. **Web lookup for new APIs.** Before flagging "this function doesn't exist", check the package's docs or the version in `node_modules`, since the model's knowledge has a cutoff.
6. **Chat on comments.** Respond to `@codeguard` replies on review comments (the `pull_request_review_comment` webhook), answering with the same context that produced the finding.

## If you fall behind

Cut in this order: Tree-sitter (use regex imports) → parallel reviewers (use one prompt) → callers-of-changed-functions → linter step → evals → trends API. **Never cut** signature verification, the outbox, the idempotent claim or Zod validation of LLM output. Those four are what make this a real system rather than a demo.

## Self-test at the end

1. Why does the webhook route not call the LLM directly?
2. What happens if Kafka is down when a webhook arrives?
3. What happens if the same PR event is delivered three times?
4. How does the reviewer know about code outside the diff?
5. Why is there a second AI call per finding?
6. Who decides pass/fail, and why not the model?
