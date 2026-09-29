# 🛡️ CodeGuard AI

An AI-powered code review platform that automatically analyses GitHub Pull Requests
and code snippets for security vulnerabilities, bugs, performance issues, and
style problems — posts inline review comments and a merge-gating Check Run, powered
by a pluggable LLM (Groq or OpenAI), Kafka, pgvector RAG, dependency graph analysis,
and a clean service-layer architecture.

> **Built as an SDE-1 portfolio project** demonstrating: TypeScript monorepo,
> service-layer design patterns, Kafka event streaming, RAG pipeline, graph
> algorithms (BFS blast-radius), vector search, and CI/CD.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Browser (Next.js UI)                        │
│         ReviewerDashboard  ·  PRReviewer  ·  /reviews/[id]         │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ HTTP (fetch)
┌──────────────────────────────▼──────────────────────────────────────┐
│                    Next.js API Routes  (thin)                        │
│  /api/review  /api/reviews  /api/github/review  /api/github/repos   │
│  /api/github/comment  /api/webhooks/github                          │
│                                                                      │
│  Auth: Clerk  ·  Validation: Zod  ·  Zero business logic here       │
└───┬──────────────────┬────────────────────┬───────────────┬─────────┘
    │                  │                    │               │
    ▼                  ▼                    ▼               ▼
┌───────────┐  ┌───────────────┐  ┌──────────────────┐  ┌──────────────┐
│   AI      │  │    GitHub     │  │    Review        │  │    User      │
│  Review   │  │   Service     │  │  Persistence     │  │   Service    │
│  Service  │  │               │  │    Service       │  │              │
│           │  │ listRepos()   │  │                  │  │ syncUser()   │
│ review    │  │ listOpenPRs() │  │ saveSnippet()    │  └──────────────┘
│ Snippet() │  │ getPRDetail() │  │ ensureRepo()     │
│ reviewPR  │  │ postComment() │  │ ensurePR()       │
│ Diff()    │  └───────┬───────┘  │ completePR()     │
└─────┬─────┘          │          │ getUserReviews()  │
      │                │          └────────┬──────────┘
      │ Groq API       │ GitHub API        │ Drizzle ORM
      ▼                ▼                   ▼
┌──────────────┐  ┌──────────┐  ┌──────────────────────┐
│  Groq LLM    │  │  GitHub  │  │   Neon PostgreSQL     │
│  or OpenAI   │  │   REST   │  │   + pgvector (RAG)    │
│  70B via API │  │   API    │  │                        │
└──────────────┘  └──────────┘  └──────────────────────┘

        ─────────── Kafka Event Flow ───────────

GitHub Webhook ──► POST /api/webhooks/github
                        │ HMAC SHA-256 verify (timingSafeEqual)
                        │ save to webhook_events table
                        │ publish → codeguard.webhook.received
                        ▼
              ┌──────────────────────┐
              │   Kafka / Redpanda   │
              │                      │
              │  webhook.received    │
              │  review.requested    │
              │  review.completed    │
              └──────────┬───────────┘
                         │ consume
              ┌──────────▼────────────────────────────────┐
              │               apps/workers                  │
              │                                             │
              │  1. webhookProcessor                        │
              │     filters PR events (opened/synchronize) │
              │     publishes review.requested              │
              │                                             │
              │  2. reviewProcessor                         │
              │     fetches PR diff from GitHub API         │
              │                                             │
              │  3. PRDiffSelector  (graph-aware)           │
              │     loads code_chunks from DB               │
              │     builds DependencyGraph                  │
              │       nodes = files                         │
              │       edges = import relationships          │
              │     BFS blast radius from changed files     │
              │     ranks files by risk score               │
              │     fills 12k char budget: riskiest first   │
              │                                             │
              │  4. RAGService  (vector search)             │
              │     embeds selected diff → query vector     │
              │     pgvector cosine search (IVFFlat index)  │
              │     returns 5 most similar code chunks      │
              │     injects as "Codebase Context"           │
              │                                             │
              │  5. Groq AI call                            │
              │     system: constraints + RAG context       │
              │     user: graph-selected diff               │
              │     → Zod validated ReviewOutput            │
              │                                             │
              │  6. Persist to DB + post GitHub comment     │
              │  7. publish review.completed                │
              │                                             │
              │  8. indexRepository (separate job)         │
              │     chunks + embeds all repo files          │
              │     stores vectors in code_chunks table     │
              └─────────────────────────────────────────────┘
```

---

## What Makes This Project Different

### 1. Graph-Aware Diff Selection
Instead of blindly truncating the diff at 12,000 characters, the worker builds a
**dependency graph** from import relationships in the codebase. When a PR changes
`src/utils/token.ts`, BFS traversal through reverse edges finds every file that
imports it — `auth.ts` → `middleware.ts` → `routes/api/users.ts`. Those files are
ranked highest for the AI review budget, so a 1-line change to a widely-imported
utility scores higher than a 200-line change to an isolated test file.

```
Changed: utils/token.ts (+1 line)

BFS blast radius:
  depth 0: utils/token.ts          ← directly changed
  depth 1: auth/verifyJWT.ts       ← imports token.ts  (HIGH RISK)
  depth 1: middleware/csrf.ts      ← imports token.ts  (HIGH RISK)
  depth 2: routes/api/users.ts     ← imports verifyJWT (MEDIUM RISK)
  depth 3: app.ts                  ← (excluded, budget full)

Unrelated: components/Button.tsx   ← NEVER included
```

### 2. RAG-Augmented Reviews
The AI doesn't just see the diff — it sees **similar code from the actual
repository** via pgvector semantic search. The PR diff is embedded to a vector,
and the 5 nearest-neighbour code chunks are injected into the prompt as context.
The LLM can now say "this conflicts with the existing pattern in `src/auth/utils.ts`"
rather than just "consider using parameterized queries."

### 3. Zod as the AI Trust Boundary
Every model response — in the web app AND the workers — is parsed through
`ReviewOutputSchema` (in `@codeguard/review-engine`) before touching the DB.
Invalid output gets one repair attempt, then the review is marked failed.
If the model hallucinates `severity: "catastrophic"` or `score: 99`, the validation
fails cleanly — no corrupt data persists, the review status is marked `"failed"`.

### 4. Service Layer Architecture
All business logic was extracted from fat route handlers into four dedicated service
classes. God-object score went from 90% → 30%. Every API route is ≤20 lines:
parse → auth check → one service call → return response.

---

## Tech Stack

| Layer | Technology | Why |
|---|---|---|
| Frontend | Next.js 16 App Router, React 19, Tailwind v4 | SSR + collocated API routes |
| Auth | Clerk (GitHub OAuth) | GitHub token access without storing creds |
| API | Next.js Route Handlers + Zod | Type-safe REST, validated I/O |
| Service Layer | TypeScript classes | Separation of concerns, testability |
| AI Reviews | `@codeguard/review-engine` → Groq (`openai/gpt-oss-120b`) or OpenAI | One engine for web + workers; provider set by `LLM_PROVIDER` |
| RAG Embeddings | OpenAI text-embedding-3-small | 1536-dim vectors, best quality/cost |
| Vector Search | pgvector (Neon PostgreSQL) | No separate vector DB needed |
| Graph Analysis | Custom BFS DependencyGraph | Blast-radius aware diff selection |
| Message Queue | Kafka (Redpanda local, Upstash prod) | Async webhook processing |
| Database | Neon PostgreSQL + Drizzle ORM | Serverless Postgres, type-safe |
| GitHub API | Octokit v5 | PR diff fetch, inline comment posting |
| Tests | Vitest (71 tests) | Fast, ESM-native |
| CI/CD | GitHub Actions | Parallel type check + lint + test + build |
| Monorepo | pnpm workspaces | Shared packages, zero duplication |

---

## Project Structure

```
codeguard-ai/
├── .github/
│   └── workflows/
│       └── ci.yml              # Parallel CI: typecheck + lint + test + build
├── apps/
│   ├── web/                    # Next.js frontend + API routes
│   │   └── src/
│   │       ├── app/api/        # Thin route handlers (auth + delegate only)
│   │       │   ├── review/     # Snippet review
│   │       │   ├── reviews/    # History + detail
│   │       │   ├── github/     # Repos, PRs, review, comment
│   │       │   └── webhooks/   # GitHub webhook receiver (HMAC verified)
│   │       ├── services/       # Business logic
│   │       │   ├── ReviewService.ts        # Starts async reviews (202 + poll), rate limit
│   │       │   ├── GitHubService.ts        # User-token Octokit calls
│   │       │   ├── ReviewPersistenceService.ts  # All DB reads/writes
│   │       │   └── UserService.ts          # Clerk→Neon user sync
│   │       └── components/     # ReviewerDashboard, PRReviewer
│   └── workers/                # Kafka consumer workers
│       └── src/
│           ├── ai/
│           │   └── EmbeddingService.ts     # OpenAI text-embedding-3-small
│           ├── analyzers/
│           │   ├── CodeChunker.ts          # Sliding window file splitter
│           │   ├── DependencyGraph.ts      # BFS import graph
│           │   ├── ImportExtractor.ts      # Regex import parser
│           │   └── PRDiffSelector.ts       # Graph-aware diff budget selector
│           ├── jobs/
│           │   ├── webhookProcessor.ts     # webhook.received → review.requested
│           │   ├── reviewProcessor.ts      # review.requested → AI → DB → GitHub
│           │   └── indexRepository.ts      # Bulk embed all repo files
│           ├── queue/
│           │   └── kafkaClient.ts          # Producer/consumer management
│           └── rag/
│               └── RAGService.ts           # pgvector similarity search
└── packages/
    ├── config/                 # Zod-validated env (fail fast, one place)
    ├── db/                     # Drizzle schema (8 tables), migrations, Neon client
    ├── review-engine/          # Prompts, LLM providers, diff annotation, validation,
    │                           #   .codeguard.yml, inline comments + Check Run
    ├── types/                  # Shared Zod schemas (ReviewInput/Output)
    └── kafka/                  # Topics (+ DLQs), event schemas, shared producer
```

---

## Key Engineering Decisions

**1. Service layer over fat route handlers**
Before: every route handler owned auth, AI calls, DB writes, and GitHub API calls
in one function (90% god-object score). After: four service classes, each with a
single responsibility. Evolvability cost dropped from 3.1 to 1.3 components per
new feature. See [`architecture_selection.md`](.kiro/specs/codeguard-ai-high-level-architecture/architecture_selection.md).

**2. Graph-aware diff selection over naive truncation**
The old approach: `.slice(0, 12_000)` — random cut, often mid-function.
The new approach: `DependencyGraph` + BFS blast radius → `PRDiffSelector` fills
the budget with complete file patches in risk order. A 1-line change to a
widely-imported file scores higher than a 200-line isolated change.

**3. Kafka for async webhook processing**
GitHub webhooks return 200 immediately while the worker processes independently.
Webhook delivery is never blocked by 2–8 second AI latency. Kafka's consumer
groups allow future services (notifications, analytics) to react to the same
events without changing the producer.

**4. RAG for codebase-aware reviews**
Without RAG, the AI sees only the diff. With RAG, it sees semantically similar
code from the actual repository (pgvector cosine search). This enables
repo-specific feedback rather than generic best-practice suggestions.

**5. Zod as the AI trust boundary**
Everything from Groq is untrusted until `ReviewOutputSchema.parse()` succeeds.
Prevents corrupt enum values, out-of-range scores, and missing required fields
from reaching the database.

---

## Getting Started

### Prerequisites
- Node.js 20+, pnpm 10+
- Docker Desktop (for Redpanda + Redis)
- Clerk account (free) — [clerk.com](https://clerk.com)
- Neon PostgreSQL database (free) — [neon.tech](https://neon.tech)
- Groq API key (free) — [console.groq.com](https://console.groq.com)
- OpenAI API key (for embeddings) — [platform.openai.com](https://platform.openai.com)

### 1. Clone and install
```bash
git clone https://github.com/your-username/codeguard-ai
cd codeguard-ai
pnpm install
```

### 2. Configure environment variables

Copy [`.env.example`](.env.example) to `apps/web/.env.local` and `apps/workers/.env`
and fill in the values. Every variable is validated at startup by
[`packages/config/src/env.ts`](packages/config/src/env.ts).

Key points:

- `LLM_PROVIDER=groq|openai` — each provider only ever uses its own API key.
- GitHub App: set the **Setup URL** to `https://<app>/api/github/app/callback` and
  enable **"Request user authorization (OAuth) during installation"**, then set
  `GITHUB_APP_CLIENT_ID` / `GITHUB_APP_CLIENT_SECRET`. The callback uses this to
  verify the signed-in user really has access to the installation.
- Grant the App **Pull requests: write** and **Checks: write** (for the Check Run).
- `GITHUB_APP_WEBHOOK_SECRET` is required outside development — unsigned webhooks
  are rejected.
- Workers mint installation tokens from `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY`.
  `GITHUB_TOKEN` is only honoured when `NODE_ENV` is not `production`.

### 3. Start infrastructure
```bash
docker-compose up -d
# Redpanda Console UI → http://localhost:8080
# Topics created automatically on first message
```

### 4. Run database migrations
```bash
pnpm db:migrate        # includes 0002: idempotency keys + install ownership
# Also run in Neon SQL console:
# CREATE EXTENSION IF NOT EXISTS vector;
```

### 5. Start development servers
```bash
# Terminal 1 — Next.js web app
pnpm dev:web          # http://localhost:3000

# Terminal 2 — Kafka workers
pnpm dev:worker       # starts webhookProcessor + reviewProcessor
```

### 6. Per-repository settings (`.codeguard.yml`)

Optional file at the repository root. It is read from the PR's **base** commit,
so a PR cannot weaken its own review.

```yaml
ignore:              # globs never sent to the model (lockfiles etc. are ignored by default)
  - "docs/**"
min_severity: low    # issues below this are not posted
fail_on: critical    # Check Run fails at/above this severity ("never" = never fail)
instructions: |      # team conventions added to the prompt
  We return Result<T, E> instead of throwing.
```

### 7. Run tests
```bash
pnpm test             # 125 tests, ~3 seconds
pnpm typecheck        # every workspace package
```

---

## CI/CD Pipeline

```
PR opened
    │
    ├── Type Check (all packages)            ┐
    ├── Lint (eslint)                        │
    ├── Unit Tests (vitest)                  ├── run in PARALLEL
    ├── Migrations & Audit (drizzle check,   │
    │     schema drift, pnpm audit)          │
    └── Secret Scan (gitleaks)               ┘
                    │
                    └── Build (next build + workers Docker image)
                                  │
                                  └── CodeGuard self-review (non-blocking)
```

Dependabot keeps npm packages, GitHub Actions and the worker's base image current.

---

## Reliability & Security

- **Idempotent reviews** — one live review per (PR, head SHA, requester), enforced by
  a partial unique index; webhook deliveries are de-duplicated by `X-GitHub-Delivery`.
- **Outbox** — every webhook is stored before it is published; if Kafka is down the
  worker's sweeper republishes it, so no delivery is lost.
- **Dead-letter topics** — invalid messages go to `*.dlq` immediately; failing ones
  after 3 attempts with backoff. Consumers heartbeat during long LLM calls.
- **Per-PR ordering** — Kafka messages are keyed by `owner/repo#number`.
- **Incremental re-review** — on `synchronize`, only commits since the last review are sent.
- **Prompt-injection hardening** — PR text and code go in the user message inside a
  random delimiter; model output can't @-mention people.
- **Install verification** — GitHub App installs are linked only after `state` (CSRF)
  and the user's own GitHub access to the installation are verified.
- **Fail-closed webhooks, verified Kafka TLS, generic API errors, per-user rate limit**
  (`REVIEW_RATE_LIMIT_PER_HOUR`).

---

## Test Coverage

| Suite | Tests | What's covered |
|---|---|---|
| `packages/types` | 23 | Zod schemas — enums, boundary scores, required fields |
| `packages/config` | 7 | Provider key isolation, Kafka TLS defaults, private-key newlines |
| `packages/review-engine` | 31 | Diff line numbers, budget, file attribution, repair retry, prompt injection, retries, inline comments + fallbacks, `.codeguard.yml` |
| `web/lib` | 9 | Webhook HMAC, fail-closed, delivery de-duplication, Kafka outage |
| `web/ReviewService` | 4 | Same commit reviewed once, async completion, failure, rate limit |
| `workers/webhookProcessor` | 8 | PR/push routing, drafts, auto-review toggle, default branch only |
| `workers/consumer` | 5 | DLQ for bad messages, retries, permanent errors |
| `workers/CodeChunker` / `RAGService` / `DependencyGraph` | 38 | Chunking, RAG formatting, BFS blast radius |
| **Total** | **125** | |

---

## What I Would Add With More Time

- **Feedback loop** — 👍/👎 or "dismiss" on findings stored as team memory, to suppress
  patterns a repository keeps rejecting
- **Typed context engine** — budgeted, weighted, provenance-tagged context packs (see `PR/context_engine.md`)
- **Multi-stage agents** — change / risk / validation stages with independent verification (see `PR/`)
- **Jira / Linear intent check** and an **evaluation set** of real PRs with known bugs
- **Self-hosted deploy** — Docker Compose with a local model instead of Groq
