# Day 1 notes: from a GitHub event to a database row

> **Goal for today:** open a PR on a test repo → GitHub sends a webhook → your app proves it came from GitHub → saves it to Postgres → answers `200` in milliseconds. You can also install the app and see your repos and PRs in the UI.

Roadmap: [ROADMAP-3-DAYS.md](../ROADMAP-3-DAYS.md) · Deep dives: [steps/01](../steps/01-connect-repo.md), [steps/02](../steps/02-receive-webhook.md)

```
 You (browser) ──Clerk sign-in──▶ Web app ──install redirect──▶ GitHub
                                    ▲                              │
                                    └─── callback (installation) ──┘

 Developer opens PR ──▶ GitHub ──POST webhook──▶ /api/webhooks/github-app
                                                  1. verify HMAC signature
                                                  2. INSERT webhook_events (unique delivery id)
                                                  3. return 200   ← nothing slow here
```

---

## 0. The big picture first (read before coding)

**Why does this project have so many pieces?** An AI review takes minutes. GitHub gives your webhook **10 seconds** to answer and doesn't retry failed deliveries automatically. So the system is split in two:

| Fast part (today) | Slow part (Days 2–3) |
|---|---|
| Web app receives the webhook, checks it, saves it, answers | Workers read jobs from Kafka and do the AI review |

Today you build only the fast part and the data it depends on. If you understand **why** the fast part must stay fast, you understand half of the architecture.

**Six words to know by tonight:** *workspace, env validation, migration, GitHub App, installation token, HMAC.*

---

## 1.1 Monorepo + local infrastructure

### Concept: pnpm workspaces
A **monorepo** is one git repo with several packages. `pnpm-workspace.yaml` (already there) says "every folder in `apps/*` and `packages/*` is a package". A package can depend on another with `"@codeguard/config": "workspace:*"`, which links the local folder instead of downloading from npm.

**Why:** the web app and the workers must agree on event shapes and DB tables. If both import the same `@codeguard/db`, a change breaks **both** at compile time, not in production.

### Concept: where things run
| Piece | Where | Why |
|---|---|---|
| Postgres | **Neon** (hosted, serverless Postgres) | Nothing to install, `pgvector` is built in, and the free tier is enough |
| Kafka | Docker on your laptop | You won't use it until Day 2; starting it now catches setup problems early |

### Concept: Neon in 4 ideas
1. **Compute scales to zero.** After a few idle minutes Neon suspends the database, so the first query afterwards takes a second or so (a "cold start"). This is normal.
2. **Two connection strings.** The **pooled** one (host contains `-pooler`) goes through PgBouncer and suits the app, which opens many short connections. The **direct** one is for migrations, which need a real session.
3. **Branches.** A branch is a cheap copy of the database. Use a `dev` branch while learning, so you can reset it without fear.
4. **SSL is required.** Neon's strings end with `?sslmode=require`; keep that.

### Setup: Neon
1. In the Neon console, create a project (pick the region closest to where you'll deploy, e.g. US East for Vercel `iad1`).
2. Create a `dev` branch, or use `main` for now.
3. Open **Connect** and copy both strings: the **pooled** one into `DATABASE_URL`, and the **direct** one (pooling toggle off) into `DATABASE_URL_UNPOOLED`.
4. In the Neon **SQL Editor**, run `CREATE EXTENSION IF NOT EXISTS vector;`. You'll need it on Day 3, and doing it now proves the extension is available.

### Build: `docker-compose.yml` (repo root, Kafka only)
```yaml
services:
  kafka:
    image: apache/kafka:3.8.0       # default config = single-node KRaft (no Zookeeper)
    ports: ["9092:9092"]
```
Run it with `docker compose up -d`, then check it with `docker compose ps`.

### Build: `packages/config`
```
packages/config/
  package.json   → { "name": "@codeguard/config", "main": "src/index.ts", "dependencies": { "zod": "..." } }
  src/index.ts
```
```ts
import { z } from "zod";

const EnvSchema = z.object({
  DATABASE_URL: z.string().url(),                 // Neon pooled (-pooler) string: used by the app
  DATABASE_URL_UNPOOLED: z.string().url().optional(), // Neon direct string: used only by migrations
  KAFKA_BROKERS: z.string().default("localhost:9092"),
  GITHUB_APP_ID: z.string().min(1),
  GITHUB_APP_SLUG: z.string().min(1),          // used to build the install URL
  GITHUB_PRIVATE_KEY: z.string().min(1),
  GITHUB_WEBHOOK_SECRET: z.string().min(16),
});

export type Env = z.infer<typeof EnvSchema>;
let cached: Env | undefined;

export function getEnv(): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid environment variables:\n${problems.join("\n")}`);
  }
  // .env files can't hold real newlines, so the PEM key is stored with "\n"
  cached = { ...parsed.data, GITHUB_PRIVATE_KEY: parsed.data.GITHUB_PRIVATE_KEY.replace(/\\n/g, "\n") };
  return cached;
}
```
Add each key to a root `.env.example` with placeholder values. Real values go in `apps/web/.env.local`, which git ignores.

> ⚠️ Don't put Clerk keys in this schema. Clerk reads `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` / `CLERK_SECRET_KEY` itself.

### ✅ Done when
- `docker compose ps` shows Kafka running.
- `SELECT extname FROM pg_extension;` in the Neon SQL Editor lists `vector`.
- Deleting `GITHUB_WEBHOOK_SECRET` makes `getEnv()` print a clear list of what's wrong.

### 🧠 Explain it
- **Why validate env at startup?** If a missing secret only blows up when the first webhook arrives, you find out at 2 a.m. in production. Checking at startup fails loudly at deploy time instead. Zod also gives you **typed** env (`env.GITHUB_APP_ID` is a `string`, not `string | undefined`).
- **Why a monorepo?** The web app and workers share contracts (tables, events). One repo gives atomic changes and compile-time safety on both sides.

---

## 1.2 Database with Drizzle

### Concept: ORM, schema, migration
- **Drizzle** lets you describe tables in TypeScript and gives you typed queries.
- A **migration** is a SQL file that moves the database from version N to N+1. You **generate** it from the schema (`drizzle-kit generate`), commit it, and **apply** it (`drizzle-kit migrate`). Never edit the DB by hand, because every environment must be able to replay the same history.

### Build: `packages/db`
```
packages/db/
  package.json        → name "@codeguard/db", deps: drizzle-orm, @neondatabase/serverless, ws ; devDeps: drizzle-kit, dotenv, @types/ws
  drizzle.config.ts
  schema/*.ts
  client.ts
  index.ts            → export * from "./schema"; export { db } from "./client"; export { eq, and, sql } from "drizzle-orm";
  migrations/         → generated, committed
```
```ts
// drizzle.config.ts (migrations use the DIRECT connection, not the pooler)
import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

config({ path: "../../apps/web/.env.local" });   // reuse the web app's env file

export default defineConfig({
  schema: "./schema/index.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL! },
});
```
```ts
// client.ts (Neon's serverless driver over WebSockets; supports transactions)
import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import ws from "ws";
import * as schema from "./schema";

neonConfig.webSocketConstructor = ws;   // Node (Next.js API routes, workers) needs a WebSocket implementation

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle({ client: pool, schema });
```
**Why this driver?** Neon offers two: `neon-http` (one HTTP request per query, simplest, but **no interactive transactions**) and `neon-serverless` (WebSocket `Pool`, works like normal `pg`, **with transactions**). On Day 2 you'll want "update the review row and insert findings" to happen in one transaction, so start with the Pool.

In `apps/web/next.config.ts`, add `serverExternalPackages: ["@neondatabase/serverless", "ws"]` and `transpilePackages: ["@codeguard/db", "@codeguard/config"]`.

### The tables for today (keep them small, you'll add columns later)
```ts
import { pgTable, uuid, text, bigint, boolean, jsonb, timestamp, integer, uniqueIndex } from "drizzle-orm/pg-core";

export const githubInstallations = pgTable("github_installations", {
  id: uuid("id").primaryKey().defaultRandom(),
  installationId: bigint("installation_id", { mode: "number" }).notNull().unique(),
  accountLogin: text("account_login").notNull(),
  accountType: text("account_type").notNull(),          // "User" | "Organization"
  accountAvatarUrl: text("account_avatar_url"),
  ownerUserId: text("owner_user_id"),                     // Clerk user id
  status: text("status").notNull().default("active"),    // active | suspended | deleted
  permissions: jsonb("permissions").notNull().default({}),
  events: jsonb("events").notNull().default([]),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const repositories = pgTable("repositories", {
  id: uuid("id").primaryKey().defaultRandom(),
  githubRepoId: bigint("github_repo_id", { mode: "number" }).notNull().unique(),
  installationId: bigint("installation_id", { mode: "number" }).notNull(),
  owner: text("owner").notNull(),
  name: text("name").notNull(),
  fullName: text("full_name").notNull(),
  private: boolean("private").notNull().default(false),
  autoReviewEnabled: boolean("auto_review_enabled").notNull().default(true),
  active: boolean("active").notNull().default(true),
});

export const webhookEvents = pgTable("webhook_events", {      // ← the OUTBOX
  id: uuid("id").primaryKey().defaultRandom(),
  deliveryId: text("delivery_id").notNull().unique(),         // X-GitHub-Delivery
  eventType: text("event_type").notNull(),                    // X-GitHub-Event
  action: text("action"),
  payload: jsonb("payload").notNull(),
  status: text("status").notNull().default("received"),      // received | published | failed
  error: text("error"),
  receivedAt: timestamp("received_at").notNull().defaultNow(),
});

export const reviews = pgTable("reviews", {
  id: uuid("id").primaryKey().defaultRandom(),
  repoFullName: text("repo_full_name").notNull(),
  prNumber: integer("pr_number").notNull(),
  headSha: text("head_sha").notNull(),
  status: text("status").notNull().default("pending"),       // pending | in_progress | completed | failed
  score: integer("score"),
  summary: text("summary"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("reviews_repo_pr_sha").on(t.repoFullName, t.prNumber, t.headSha)]);
```
(`users` and `review_findings` can wait until you need them, which is fine.)

### 📐 Why this schema: table by table

#### The four tables at a glance
```
 github_installations          repositories                 webhook_events            reviews
 ─────────────────────         ─────────────────            ──────────────            ───────
 WHO installed CodeGuard  ──▶  WHICH repos it can see       EVERY GitHub event,       ONE AI review per
 and WHAT it may do            + auto-review on/off         saved first (outbox)      PR commit
 installation_id (unique)      github_repo_id (unique)      delivery_id (unique)      (repo, pr, sha) (unique)
 owner_user_id → Clerk user    installation_id ─┘           status: received →        status: pending →
                                                            published / failed        in_progress → completed / failed
```

| Table | Answers the question | Written by | Read by |
|---|---|---|---|
| `github_installations` | "Who installed CodeGuard, and what may it do?" | install callback, `installation` webhook | `/install` page, workers (to get tokens) |
| `repositories` | "Which repos can CodeGuard see? Is auto-review on?" | callback, `installation_repositories` webhook, toggle | repo drawer, PR list, Day 2 router |
| `webhook_events` | "What did GitHub send us, and has it been handed off?" | webhook route, publisher, sweeper | sweeper, you while debugging |
| `reviews` | "What did the AI conclude about this exact commit?" | workers | dashboard, review page, trends |

#### One pull request, table by table
```
 1. User installs the App        → INSERT github_installations, INSERT repositories (one per granted repo)
 2. Developer opens PR #7        → GitHub POSTs a webhook
 3. Webhook route                → INSERT webhook_events (status = received)      ← answers 200 here
 4. Day 2: publisher             → UPDATE webhook_events SET status = published
 5. Day 2: router                → SELECT repositories WHERE full_name = … → auto_review_enabled?
 6. Day 2: worker claims review  → INSERT reviews (…) ON CONFLICT DO NOTHING      ← only one wins
 7. Day 2: worker runs the AI    → UPDATE reviews SET status = in_progress … completed, score, summary
 8. Developer pushes again       → new head SHA → steps 2–7 again → a NEW reviews row
```
If you can replay these 8 steps from memory, you understand the schema.

#### `github_installations`: who installed CodeGuard
When a user or org installs the App, GitHub creates an *installation* with its own id. Every later API call uses a token **for that installation**, so this table is the root of everything CodeGuard is allowed to do.

| Column | Why it's there |
|---|---|
| `id` (uuid) | Our own id. Not guessable, and any process can create one without asking the DB |
| `installation_id` (bigint, **unique**) | GitHub's id: what we pass to Octokit to get a token. Unique because the callback **and** the webhook both upsert it, so they must land on one row. `bigint` because GitHub ids exceed 32-bit |
| `account_login` | The username or org name that installed it. Shown in the UI and used in the ownership check |
| `account_type` | `User` or `Organization`. The callback check differs: a personal install must match the user's GitHub login, an org needs a membership check |
| `account_avatar_url` | UI only, so nullable: never block on cosmetics |
| `owner_user_id` | The **Clerk** user id that links our two identities (Clerk = who is on the website; GitHub App = what CodeGuard may do). Nullable because the `installation` webhook can arrive **before** the browser returns to the callback |
| `status` | `active / suspended / deleted`, driven by webhooks. A soft delete keeps old reviews meaningful |
| `permissions`, `events` (jsonb) | What GitHub granted. GitHub controls the shape; we only read it back, never filter on it |
| `created_at`, `updated_at` | When it appeared and when it last changed: answers "when did this change?" while debugging |
| index on `owner_user_id` | "Installations for the signed-in user" runs on almost every page |

#### `repositories`: which repos CodeGuard can see
A local copy of the granted repos, so the UI doesn't call GitHub's API on every page load. The Day 2 router also checks it before creating a review job.

| Column | Why it's there |
|---|---|
| `github_repo_id` (**unique**) | Repos can be **renamed or transferred**, but the numeric id never changes. So this is the identity, not the name |
| `installation_id` | Which installation token to use for this repo |
| `owner`, `name` | What GitHub's REST API wants: `pulls.list({ owner, repo: name })` |
| `full_name` | `owner/name`: how webhooks, URLs and the UI refer to a repo. Stored so it can be indexed |
| `private` | Lock icon in the UI, and a reminder that private code must never leak into logs |
| `auto_review_enabled` | The per-repo switch. Default **on**, because that's why people install a reviewer |
| `active` | `false` when the repo is removed from the install. Soft delete: past reviews still show, and a re-grant flips it back |
| indexes on `installation_id`, `full_name` | The repo drawer ("repos for these installs") and webhook lookups ("find `owner/name`") |

#### `webhook_events`: the outbox ⭐ the most important table
GitHub gives you 10 s and doesn't retry automatically, while a review takes minutes. So the route only does **verify → insert here → 200**. Once the row exists the event can't be lost: if Kafka is down (Day 2), the row stays `received` and a sweeper (Day 3) publishes it later.

| Column | Why it's there |
|---|---|
| `delivery_id` (**unique**) | The `X-GitHub-Delivery` header. Unique means a duplicate delivery or a "Redeliver" click becomes a no-op |
| `event_type` | The `X-GitHub-Event` header (`pull_request`, `installation`…). A column so you can route and filter without parsing JSON |
| `action` | `opened`, `synchronize`… Nullable, because some events (like `push`) have no action |
| `payload` (jsonb) | The exact body GitHub sent. Lets you replay or debug without asking GitHub again. `jsonb` is smaller and faster than `json` |
| `status` | `received → published` (or `failed`): where the event is in its journey |
| `error` | The last publish error. Without it, a stuck row is a mystery |
| `received_at` | The sweeper only republishes rows older than N seconds, so it doesn't race a request that is still publishing |
| `published_at` | `published_at − received_at` = publish delay |
| index `(status, received_at)` | The sweeper's query `WHERE status='received' AND received_at < now()-30s`. This table grows fastest, so it must not be scanned in full |

#### `reviews`: one AI review per commit
**Why per commit and not per PR?** Every push changes a PR. A review is only true for the exact code it read, so the key is *(repo, PR number, head SHA)*. A new push gives a new SHA and a new review.

| Column | Why it's there |
|---|---|
| `id` (uuid) | Appears in URLs (`/reviews/<id>`). Sequential numbers would let people guess other reviews |
| `repo_full_name`, `pr_number` | Which PR. A PR number is only unique inside a repo, so the two always go together |
| `head_sha` | The exact commit reviewed. Day 2 also uses it to mark old reviews "outdated" and to post the Check Run on the right commit |
| `status` | `pending → in_progress → completed / failed`. These exact strings are what `RepoPulls.tsx` expects |
| `score` | 0–100, **NULL until done**, so "no score yet" can't be mistaken for "terrible code" (0) |
| `summary` | The short verdict for the dashboard and the PR comment |
| `updated_at` | Also a liveness signal: Day 3's sweeper fails reviews stuck `in_progress` for 10+ min |
| **unique `(repo_full_name, pr_number, head_sha)`** | **The key idempotency guarantee.** The worker claims with `INSERT … ON CONFLICT DO NOTHING`, and only one insert can win, so two workers never review the same commit |
| index on `created_at` | Dashboard "newest first" and trends "last N days" |

> ⚠️ Known shortcut: `repo_full_name` is a *name*, so after a repo rename, old reviews keep the old name. When that matters, add a `repository_id` column pointing at `repositories.id`.

#### Seven design rules behind all of this
1. **Guarantees live in the database, not in `if` checks.** `if (!exists) insert()` has a gap where two requests can both pass the check. A `UNIQUE` constraint has no gap. Pair it with `ON CONFLICT DO NOTHING` (skip) or `DO UPDATE` (upsert).
2. **GitHub's numeric ids are identity; names are display.** Names change, ids don't.
3. **UUID primary keys** for our own rows: not guessable, no coordination needed. GitHub's ids are stored separately as `bigint`.
4. **Soft-delete rows that others refer to** (`status = 'deleted'`, `active = false`). History stays readable, and a late webhook can't bring stale state back.
5. **Columns for what you query, `jsonb` for what you only store.** Once you keep writing `WHERE payload->>'x'`, promote that field to a column.
6. **Statuses are `text` + a TypeScript enum, not a Postgres `ENUM`.** You get autocomplete and type errors in code, and a new value is a code change, not an `ALTER TYPE` migration. The trade-off: the DB won't catch a typo, so always write statuses through typed code.
7. **Every timestamp is `timestamptz`.** Your laptop (IST), Vercel (UTC) and Neon agree on the moment; plain `timestamp` gives "off by 5.5 hours" bugs.

#### Why no foreign keys (yet)?
A foreign key forces insert order: no repo row before its installation row. But GitHub webhooks **don't arrive in a guaranteed order**. The `installation` webhook races the browser callback, and `installation_repositories` can come first. A strict foreign key would reject a valid event because of timing, and a failed webhook insert means a **lost event**. So these tables are linked by value (`repositories.installation_id` = `github_installations.installation_id`), and the app keeps them consistent.

When **we** control the write order, as with `review_findings → reviews` on Day 2, use real foreign keys with `ON DELETE CASCADE`.

#### Tables that come later, and why they wait
| Table | Added in | Why it waits |
|---|---|---|
| `review_findings` | Day 2.3 | Its shape comes from the AI output format you design then (file, line, severity, category, message) |
| `code_chunks` (+ `vector` column) | Day 3.1 | Needs your chunking and embedding choice. The `vector` extension is already enabled |
| `users` | Only if needed | Clerk already stores users; `owner_user_id` is enough until you need per-user settings |

#### Changing the schema safely
```bash
pnpm db:generate    # writes a new SQL file in packages/db/migrations/
```
Open that SQL file and **read it** before migrating. Watch for `DROP COLUMN`, `DROP TABLE`, or a type change on a column that already has data.
```bash
pnpm db:migrate     # applies it to Neon (via DATABASE_URL_UNPOOLED)
```
Never edit a migration that has already been applied. Fix mistakes with a **new** migration, because every environment replays the same files in order.

Add scripts to `packages/db/package.json`: `"db:generate": "drizzle-kit generate"`, `"db:migrate": "drizzle-kit migrate"`. Then run `pnpm --filter @codeguard/db db:generate` followed by `db:migrate`.

### ✅ Done when
The Neon console's **Tables** view lists your tables (or run `npx drizzle-kit studio` from `packages/db`). The `__drizzle_migrations` table in the `drizzle` schema shows which migrations have been applied.

### 🧠 Explain it
- **Unique `(repo, pr, sha)` on `reviews`:** the same commit can trigger review requests more than once (redelivery, double click, Kafka redelivery on Day 2). The DB refuses a second row, so **two workers can never review the same commit twice**. The database enforces it, not your code.
- **Unique `delivery_id`:** GitHub can deliver the same webhook twice, and you can click "Redeliver". The unique column turns a duplicate into a harmless no-op.

> 💡 **Rule of thumb:** guarantees like "never twice" belong in **database constraints**, not in `if (exists) return`. The `if` check has a race window between two requests; the constraint doesn't.

---

## 1.3 GitHub App + install flow

### Concept: GitHub App vs OAuth App vs personal token
| | Personal token | OAuth App | **GitHub App** ✅ |
|---|---|---|---|
| Acts as | You | A user | **Itself (a bot)** |
| Permissions | Broad scopes | Broad scopes | **Fine-grained, per repo** |
| Works when user is offline | Yes, forever (dangerous) | Tied to user | **Yes** |
| Token lifetime | Until revoked | Long | **~1 hour** |
| Gets webhooks for installed repos | No | No | **Yes, built in** |

You use **two identities** that never mix:
- **Clerk** answers "who is this person on *my website*?" (GitHub sign-in through OAuth).
- **The GitHub App** answers "what is CodeGuard allowed to do on *which repos*?"

### Concept: how the App authenticates (two steps)
```
private key ──sign──▶ App JWT (10 min, proves "I am app #123")
App JWT ──POST /app/installations/{id}/access_tokens──▶ installation token (1 h, scoped to that install's repos)
```
The `octokit` package does both for you:
```ts
// apps/web/src/server/github-app.ts
import { App } from "octokit";
import { getEnv } from "@codeguard/config";

let app: App | undefined;
export function githubApp() {
  const env = getEnv();
  return (app ??= new App({ appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_PRIVATE_KEY }));
}
// Usage: const octokit = await githubApp().getInstallationOctokit(installationId);
//        await octokit.request("GET /installation/repositories", { per_page: 30 });
```

### Setup: create the App (GitHub → Settings → Developer settings → GitHub Apps → New)
- **Webhook URL:** a public tunnel to your laptop. Go to https://smee.io, click "Start a new channel", then run:
  ```bash
  npx smee-client --url https://smee.io/YOUR_CHANNEL --target http://localhost:3000/api/webhooks/github-app
  ```
- **Webhook secret:** a long random string. Put the same value in `GITHUB_WEBHOOK_SECRET`.
- **Setup URL (post-install redirect):** `http://localhost:3000/api/github/app/callback`
- **Permissions:** Pull requests R/W · Contents R · Checks R/W · Metadata R
- **Subscribe to events:** Pull request (installation events are sent automatically)
- Generate a **private key** (.pem). Store it in `GITHUB_PRIVATE_KEY` with newlines written as `\n`.

### Build: the routes (the UI already calls these, so match the shapes)
| Route | Does | Response the UI expects |
|---|---|---|
| `GET /api/github/app/install` | Make a random `state`, put it in an httpOnly cookie, redirect to `https://github.com/apps/<slug>/installations/new?state=…` | redirect |
| `GET /api/github/app/callback` | Check `state` matches the cookie → check the install (below) → upsert installation + its repos with `ownerUserId = auth().userId` → redirect to `/install` | redirect |
| `GET /api/github/app/installations` | Installations owned by the signed-in user | `{ installations: InstallationRow[] }` (see `src/lib/installations.ts`) |
| `GET/DELETE /api/github/app/installations/[id]` | One installation / unlink it | row / `{ ok: true }` |
| `GET /api/github/app/repositories?page&pageSize&q` | Repos from the user's installations | `{ repos: GrantedRepo[], hasMore }` (see `RepoDrawer.tsx`) |
| `GET /api/github/app/repositories/[owner]/[repo]/pulls` | Open PRs through the installation Octokit | `{ repo: RepoInfo, pulls: Pull[], hasMore }` (`review` can be `null` for now; see `RepoPulls.tsx`) |
| `POST /api/github/repos/[owner]/[repo]/auto-review` | Flip `autoReviewEnabled` | updated repo |

Every route except the webhook is already protected by Clerk in `src/proxy.ts`. Inside a handler, `const { userId } = await auth()` (from `@clerk/nextjs/server`) gives you the user.

**Checking the callback (don't skip this):** anyone can visit `/callback?installation_id=999` with someone else's id. So:
1. `state` must equal the cookie value (CSRF protection).
2. Load the installation **as the App** (`githubApp().octokit.request("GET /app/installations/{installation_id}")`) to confirm it exists and to read `account.login`.
3. Confirm the signed-in user can access that account. For a personal install, the account login equals the user's GitHub username (from Clerk's GitHub external account). For an org, check that the user is a member.

### ✅ Done when
You sign in, click Install, pick a test repo, land back on `/install` and see the installation, and the dashboard drawer lists the repo and its open PRs.

### 🧠 Explain it
- **Why does the private key never leave the server?** Anyone holding it can mint tokens for **every** installation of your app. It belongs only in server env vars, never in `NEXT_PUBLIC_*` and never in git.
- **Why are installation tokens short-lived?** A leaked token is useful for at most an hour and only on the repos that installation covers. Compare that with a personal token that never expires and can reach everything you can.

---

## 1.4 Receive the webhook safely

### Concept: HMAC, the "is it really GitHub?" check
GitHub and you share a secret. For every delivery GitHub computes `HMAC-SHA256(secret, rawBody)` and sends it in `X-Hub-Signature-256: sha256=<hex>`. You compute the same thing. If the values match, the sender knew the secret, so it was GitHub, and the body wasn't changed on the way.

```ts
// apps/web/src/server/webhook-signature.ts
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyGitHubSignature(rawBody: string, header: string | null, secret: string): boolean {
  if (!secret || !header?.startsWith("sha256=")) return false;          // fail CLOSED
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);                 // constant-time compare
}
```

**Three traps:**
1. **Use the raw body.** `JSON.stringify(JSON.parse(body))` can change spacing and key order, so the hash won't match. Use `await req.text()` and parse **after** verifying.
2. **`timingSafeEqual`, not `===`.** `===` stops at the first wrong byte, so an attacker can measure response times and guess the signature byte by byte. `timingSafeEqual` always takes the same time. It throws on different lengths, so check the length first.
3. **No secret means reject.** Never "skip the check if the secret isn't set".

### Build: the route
```ts
// apps/web/src/app/api/webhooks/github-app/route.ts
import { db, webhookEvents } from "@codeguard/db";
import { getEnv } from "@codeguard/config";
import { verifyGitHubSignature } from "@/server/webhook-signature";

export const runtime = "nodejs";            // node:crypto needs the Node runtime

export async function POST(req: Request) {
  const raw = await req.text();
  if (!verifyGitHubSignature(raw, req.headers.get("x-hub-signature-256"), getEnv().GITHUB_WEBHOOK_SECRET)) {
    return Response.json({ error: "invalid signature" }, { status: 401 });
  }

  const deliveryId = req.headers.get("x-github-delivery");
  const eventType = req.headers.get("x-github-event");
  if (!deliveryId || !eventType) return Response.json({ error: "missing headers" }, { status: 400 });

  const payload = JSON.parse(raw);
  const inserted = await db
    .insert(webhookEvents)
    .values({ deliveryId, eventType, action: payload.action ?? null, payload })
    .onConflictDoNothing({ target: webhookEvents.deliveryId })
    .returning({ id: webhookEvents.id });

  if (inserted.length === 0) return Response.json({ ok: true, duplicate: true });

  // installation / installation_repositories → upsert into github_installations / repositories here (fast DB writes only)
  // Day 2: publish to Kafka here and mark the row "published"

  return Response.json({ ok: true });
}
```
`src/proxy.ts` already lists `/api/webhooks/(.*)` as public, which is correct. Webhooks prove who they are with the HMAC, not with a Clerk session.

### Build: tests (Vitest)
Add `vitest` to `apps/web` devDependencies and create `src/server/__tests__/webhook-signature.test.ts`:
- a valid signature returns `true`
- a body changed by one character returns `false`
- a missing header, a wrong prefix or an empty secret returns `false`
- a header of different length returns `false` (and doesn't throw)

### ✅ Done when
- Opening a PR creates **exactly one** `webhook_events` row.
- In the App settings, go to "Advanced" and **Redeliver** the event. No new row appears and the response says `duplicate: true`.
- A `curl -X POST` with no signature gets `401`.

### 🧠 Explain it
- **Why constant-time comparison?** See trap 2: it stops attackers from learning the signature through response timing.
- **Why answer within 10 s, and why do nothing slow here?** GitHub marks slow deliveries as failed and **doesn't retry them**, so the event would be lost. Saving the row takes milliseconds. The AI review takes minutes and belongs to the workers (Day 2).
- **Why save to the DB before anything else?** Postgres is the **source of truth**. Once the row exists the event can't be lost; tomorrow a sweeper will republish anything Kafka missed. This is the **outbox pattern**.

---

## Common mistakes on Day 1

| Symptom | Likely cause |
|---|---|
| Signature always invalid | You hashed parsed JSON, the secret has extra whitespace, or smee isn't forwarding to the right path |
| `error:1E08010C:DECODER` / key errors | The PEM key's `\n` wasn't turned back into real newlines |
| Callback lands but no installation shows | `ownerUserId` wasn't set, or the state cookie was lost (check `sameSite: "lax"` and the path) |
| `relation "…" does not exist` | You generated the migration but didn't run `db:migrate`, or you migrated a different Neon **branch** than the one in `DATABASE_URL` |
| Migration hangs or fails with prepared-statement / session errors | You ran migrations through the `-pooler` URL; use `DATABASE_URL_UNPOOLED` |
| `All attempts to open a WebSocket to connect to the database failed` | You forgot `neonConfig.webSocketConstructor = ws`, or `ws` isn't in `serverExternalPackages` |
| First request after a break takes 1–3 s | Neon compute waking from scale-to-zero; normal, ignore it |
| `drizzle-kit` says `DATABASE_URL` is undefined | `drizzle.config.ts` didn't load the env file; check the `dotenv` path |
| Webhook returns 404/307 | It isn't public in `proxy.ts`, or the route file path is wrong |
| Next.js can't import `@codeguard/*` | Add the packages to `transpilePackages` in `next.config.ts` and add them as `workspace:*` deps in `apps/web/package.json` |

---

## End-of-day checklist

- [ ] Neon project + `dev` branch created; pooled and direct URLs in `.env.local`; `vector` extension enabled
- [ ] `docker compose up -d` runs Kafka
- [ ] `getEnv()` rejects bad env with a clear message
- [ ] Migrations create `github_installations`, `repositories`, `webhook_events`, `reviews`
- [ ] GitHub App created; smee tunnel forwards to localhost
- [ ] Install → callback → installation visible on `/install`
- [ ] Repo drawer and PR list load in the dashboard
- [ ] PR opened → one `webhook_events` row; redelivery → no duplicate; no signature → 401
- [ ] Signature tests pass
- [ ] **From memory**, draw: GitHub → webhook route → verify → Postgres → 200

## Self-quiz (answer without looking)

1. What's the difference between what Clerk knows and what the GitHub App knows?
2. What two tokens does the App use, and how long does each live?
3. Why is the uniqueness rule on `delivery_id` a DB constraint and not an `if` check?
4. What would go wrong if you verified the signature against `JSON.stringify(payload)`?
5. Why must the webhook handler never call the AI?
6. Which Neon connection string do migrations use, which one does the app use, and why?
7. Why is `reviews` unique per **commit** and not per **PR**?
8. Why is `repositories.github_repo_id` the unique key and not `full_name`?
9. Why is there no foreign key from `repositories` to `github_installations`?
10. Why is `reviews.score` NULL instead of 0 before the review completes?
11. If Postgres is down when a webhook arrives, what should the handler return, and why? *(Hint: a 500, so GitHub records a failed delivery that someone can redeliver.)*

**Tomorrow (Day 2):** the `// Day 2` comment in the webhook route becomes a Kafka publish, and workers pick the job up from there.
