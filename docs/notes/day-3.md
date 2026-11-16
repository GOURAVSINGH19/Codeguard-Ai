# Day 3 notes: make it smart, then make it reliable

> **Goal for today:** reviews see **beyond the diff** (related code, the files a change affects, the callers of changed functions). Three reviewers run in parallel. A second model checks every finding. A team policy in `.codeguard.yml` decides pass/fail. The system **heals itself** when things crash. The trends page works.

Roadmap: [ROADMAP-3-DAYS.md](../ROADMAP-3-DAYS.md) · Previous: [day-2.md](day-2.md) · Deep dives: [steps/05](../steps/05-index-code.md), [07](../steps/07-prepare-context.md), [08](../steps/08-staged-review.md), [09](../steps/09-verify-findings.md), [10](../steps/10-decide.md), [13](../steps/13-recovery.md) · AI: [ai/04](../ai/04-embeddings-and-rag.md), [05](../ai/05-context-engineering.md), [06](../ai/06-blast-radius.md), [07](../ai/07-verifier.md), [08](../ai/08-evals.md), [09](../ai/09-pipeline-vs-agent.md)

```
                 ┌──────────────── PREPARE CONTEXT ────────────────┐
 diff ─────────▶ │ RAG: similar code (pgvector)                     │
                 │ blast radius: who imports the changed files      │
                 │ callers: where changed functions are used        │
                 │ policy + path_instructions from .codeguard.yml   │
                 └───────────────────────┬──────────────────────────┘
                                         ▼
 Stage 1  what changed?  ──▶  Stage 2  how risky?  ──▶  Stage 3  quality ∥ security ∥ testing
                                                                         │
                                                  merge + dedupe ◀───────┘
                                                         │
                                                  VERIFIER (2nd model) → drop rejected
                                                         │
                                       score + POLICY (code, not AI) → pass / fail
                                                         │
                                            publish: comments · Check Run · dashboard
```

---

## 0. The big picture first

Yesterday's reviewer is like a smart stranger reading one page torn out of a book. It can spot typos, but it can't tell that the sentence it is reading breaks chapter 7. Today you give it the **rest of the book**, but only the relevant pages, because:

> **Context beats a bigger model.** What the model *sees* matters more than which model it is. Too little context and it guesses; too much and the important lines drown. Picking the right context is the job.

**Six words to know by tonight:** *embedding, cosine distance, reverse import graph, BFS, verifier, policy-as-code.*

---

## 3.1 Code indexing + RAG

### Concept: embeddings in 4 ideas
1. An **embedding model** turns text into a list of numbers (a vector, e.g. 384 numbers).
2. Texts with **similar meaning** get vectors that **point the same way**: `verifyJwt(token)` and `checkAuthToken(t)` land close together even though they share no words.
3. **Cosine distance** measures how far apart two vectors point (0 = same direction).
4. **RAG** (Retrieval-Augmented Generation): embed the diff, find the closest stored code chunks, and paste them into the prompt.

### Concept: pgvector
A Postgres extension (already enabled on your Neon DB) that adds a `vector(N)` column type, distance operators (`<=>` is cosine distance), and an **HNSW** index for fast nearest-neighbour search. Code search lives next to the rest of your data: no extra database.

### Choose an embedding model
| Option | Dims | Cost | Notes |
|---|---|---|---|
| **Local** `@huggingface/transformers` + `Xenova/all-MiniLM-L6-v2` | 384 | Free, runs in the worker | Recommended for learning; good enough for "find related code" |
| OpenAI `text-embedding-3-small` | 1536 | Paid API | Better quality; needs another key |
| Voyage `voyage-code-3` | 1024 | Paid API | Trained on code |

Groq (your LLM) has no embeddings endpoint, so embeddings come from a separate provider. **The dimension is fixed by the column**, so changing the model later means re-indexing.

### Schema
```ts
import { vector, index, ... } from "drizzle-orm/pg-core";

export const codeChunks = pgTable("code_chunks", {
  id: uuid("id").primaryKey().defaultRandom(),
  repositoryId: uuid("repository_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
  path: text("path").notNull(),
  symbol: text("symbol"),                         // "verifyJwt", or null for a plain line window
  startLine: integer("start_line").notNull(),
  endLine: integer("end_line").notNull(),
  content: text("content").notNull(),
  contentHash: text("content_hash").notNull(),    // sha256: skip re-embedding unchanged chunks
  embedding: vector("embedding", { dimensions: 384 }).notNull(),
  commitSha: text("commit_sha").notNull(),
}, (t) => [
  index("code_chunks_repo_path_idx").on(t.repositoryId, t.path),
  index("code_chunks_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
]);

// One row per file: its imports. This feeds the blast radius in 3.2.
export const codeFiles = pgTable("code_files", {
  repositoryId: uuid("repository_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
  path: text("path").notNull(),
  blobSha: text("blob_sha").notNull(),            // git blob sha: unchanged file → skip
  imports: text("imports").array().notNull(),     // resolved repo paths this file imports
}, (t) => [primaryKey({ columns: [t.repositoryId, t.path] })]);
```

### Chunking: how to cut code into pieces
| Strategy | Pros | Cons |
|---|---|---|
| Fixed line windows (60 lines, 10 overlap) | Works for any language in 10 lines of code | Cuts functions in half |
| **TypeScript compiler API** (`ts.createSourceFile`) → one chunk per top-level function/class | Real boundaries, no native build | JS/TS only |
| Tree-sitter | Real boundaries for many languages | Native modules or WASM to set up |

Start with the TS compiler API for `.ts/.tsx/.js/.jsx` and line windows for everything else. Put a short header in each chunk before embedding: `// file: src/auth/jwt.ts · function verifyJwt`. The path carries meaning too.

### Build: two indexers (in the workers)
- **Full index**, triggered by `installation.created` (and a manual "re-index"): new topic `codeguard.repo.index.requested`.
  1. `git.getTree({ tree_sha: defaultBranch, recursive: "true" })` lists every file.
  2. Keep code files under ~200 KB and skip `node_modules/`, `dist/`, lockfiles, minified files. Cap at ~2,000 files (API rate limit: 5,000 requests/hour per installation).
  3. `git.getBlob` → decode → chunk → embed in batches → upsert `code_chunks` + `code_files`.
- **Incremental index**, triggered by a `push` to the default branch (subscribe to **Push** in the App settings): re-index only the files in `payload.commits[].added/modified`, and delete rows for `removed`. `blobSha` / `contentHash` let you skip anything unchanged.

### Retrieval at review time
```ts
import { cosineDistance, asc, and, eq, notInArray } from "drizzle-orm";

const queryVec = await embed(changedHunksText);                 // the diff, as one query
const related = await db.select({ path: codeChunks.path, content: codeChunks.content, startLine: codeChunks.startLine })
  .from(codeChunks)
  .where(and(eq(codeChunks.repositoryId, repoId), notInArray(codeChunks.path, changedPaths)))  // the diff is already in the prompt
  .orderBy(asc(cosineDistance(codeChunks.embedding, queryVec)))
  .limit(8);
```
Put the results in the prompt as `<related_code path="…" lines="…">`. Stay within your token budget: drop the furthest chunks first.

### ✅ Done when
A review comment mentions a file that is **not in the diff** ("`middleware/auth.ts` trusts the value this function now returns unverified").

### 🧠 Explain it
- **Why embeddings and not plain text search?** Plain search needs shared words. Embeddings find code with the same *meaning*: `isAdmin()` and `hasRole('admin')` match.
- **Why keep vectors in Postgres?** One database, one backup. You can join with `repositories` and filter by repo in the same query. At this scale a separate vector DB adds operations work without adding quality.

---

## 3.2 Blast radius + staged review

### Concept: blast radius
*If this file changes, what else could break?* Build a graph where an edge `A → B` means "A imports B". **Reverse** it (`B ← A`: "B is imported by A"), then walk outwards from the changed files with **BFS** (breadth-first search). Every file you reach can be affected. A one-line change to a utility imported by 120 files is riskier than 300 new lines in a test file nobody imports.

### Build: the import graph
```ts
import ts from "typescript";

// Cheapest correct import parser: TypeScript's own pre-processor (no type checking, no full AST)
function importsOf(path: string, content: string, allPaths: Set<string>): string[] {
  const { importedFiles } = ts.preProcessFile(content, true, true);
  return importedFiles.map((f) => resolveImport(path, f.fileName, allPaths)).filter((p): p is string => !!p);
}
// resolveImport: handle "./x", "../x", and tsconfig aliases like "@/lib/x" → "src/lib/x";
// try x.ts, x.tsx, x.js, x/index.ts …; ignore bare packages ("react") and anything not in allPaths
```
Store the result in `code_files.imports` during indexing (3.1), so a review never re-parses the whole repo.

```ts
// blastRadius.ts
export function blastRadius(changed: string[], files: { path: string; imports: string[] }[], maxDepth = 3) {
  const importedBy = new Map<string, string[]>();
  for (const f of files) for (const dep of f.imports) importedBy.set(dep, [...(importedBy.get(dep) ?? []), f.path]);

  const seen = new Map<string, number>(changed.map((p) => [p, 0]));   // path → distance
  const queue = [...changed];
  while (queue.length) {
    const cur = queue.shift()!;
    const d = seen.get(cur)!;
    if (d >= maxDepth) continue;
    for (const parent of importedBy.get(cur) ?? []) {
      if (!seen.has(parent)) { seen.set(parent, d + 1); queue.push(parent); }
    }
  }
  return [...seen].filter(([p]) => !changed.includes(p)).map(([path, distance]) => ({ path, distance }));
}
```

### Build: callers of changed functions *(CodeRabbit idea)*
1. Parse the HEAD version of each changed file with `ts.createSourceFile` and find the **function/class/exported const that contains each changed line**: those are the *changed symbols*.
2. In the affected files (distance 1–2), search for `\bsymbolName\s*\(` (or `new SymbolName`).
3. Add each hit as a ±5-line snippet: `<caller of="verifyJwt" path="middleware/auth.ts" line="31">…</caller>`.

This catches *"you changed what `verifyJwt` returns; here are the 4 places that rely on the old behaviour"*, which RAG often misses because callers don't *look* like the function they call.

### Build: risk assessment (Stage 2): code, not AI
```ts
const CRITICAL = /(auth|login|session|jwt|token|password|crypto|payment|billing|migration|permission|secret)/i;
let score = 0;
score += Math.min(40, affected.length * 2);                 // blast radius
score += changed.some((p) => CRITICAL.test(p)) ? 30 : 0;    // critical paths
score += Math.min(20, Math.floor(linesChanged / 50) * 5);   // size
score += deletesTests ? 10 : 0;
const level = score >= 70 ? "critical" : score >= 45 ? "high" : score >= 20 ? "medium" : "low";
```
Keep `factors: string[]` ("imported by 37 files", "touches auth/") so the UI and the PR comment can **explain** the risk.

### Build: the staged pipeline
Write `reviews.progress` at each node, using **these exact names** so the UI's `progressLabel()` shows nice text:

| Stage | Node names (`progress`) | What happens |
|---|---|---|
| Prepare | `snapshot_repository`, `collect_pr_context`, `build_context_packs`, `build_software_graph` | diff, lint, RAG, blast radius, callers, policy file |
| 1 | `committer` | One small LLM call: summarize intent, change type, does it match the PR description? |
| 2 | `blast_radius`, `risk_assessment` | The code above |
| 3 | `quality`, `security`, `testing` | **Three LLM calls in parallel**, each with its own system prompt and categories |
| Merge | `aggregate_findings`, `deduplicate_findings` | Combine and remove duplicates |
| 3.3 | `independent_verify`, `scorecard`, `policy_evaluation`, `assurance_decision` | Verifier, score, policy |
| Out | `publish_report`, `done` | GitHub + DB |

```ts
const [quality, security, testing] = await Promise.allSettled([
  reviewer("quality", ctx), reviewer("security", ctx), reviewer("testing", ctx),
]);
// allSettled, not all: one reviewer timing out shouldn't throw away the other two.
```
**Context budget:** the diff is always included. Then add, in order of value, until the budget runs out: callers → blast-radius file headers → RAG chunks. The security reviewer gets more of the auth-related context; the testing reviewer gets the test files of affected modules.

**Dedupe:** two findings are the same if they're in the same file, within ±2 lines, with similar messages (word-overlap ratio > 0.6). Keep the higher severity and merge their `source`s.

### ✅ Done when
A one-line change to a widely imported util gets **higher** risk than a 300-line isolated change, and the review lists the affected callers.

### 🧠 Explain it
- **Why a pipeline and not an autonomous agent?** Every run follows the same steps, so it's predictable, cheap, testable and easy to debug from `trace`. An agent that decides what to read is more flexible but slower, costlier and harder to evaluate. See [ai/09](../ai/09-pipeline-vs-agent.md).
- **Why three reviewers instead of one big prompt?** A focused prompt beats a "check everything" prompt, the three run in parallel (same wall-clock time), and each gets context picked for its job.

---

## 3.3 Verifier + policy decision

### Concept: the verifier
Reviewers are tuned to **find** things, so some findings are false alarms. A second, independent call gets **one finding + the real code around it (±15 lines at the head SHA)** and must answer *confirmed / rejected / uncertain + reason*. It's cheaper to check a claim than to make one, and a false positive costs developer trust.

```ts
const Verdict = z.object({
  id: z.string(),
  verdict: z.enum(["confirmed", "rejected", "uncertain"]),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(400),
});
// Batch 5–10 findings per call. Use a different (ideally stronger) model than the reviewers if you can.
// rejected → drop · uncertain → keep, confidence < 0.5, never block on it · confirmed → keep
// Save confidence on review_findings; save counts in assurance.verification.
```
Give the verifier the team's `path_instructions` too, so it rejects findings that contradict team rules.

### Concept: policy-as-code
The AI gives **opinions**. **Code** decides pass/fail from rules the team wrote, which makes it predictable ("same input → same verdict"), explainable ("failed: 1 critical security finding in `src/auth/**`"), and safe from prompt injection (the model can't vote itself through).

### Build: `.codeguard.yml`
```yaml
# .codeguard.yml in the repo root
fail_on: [critical, high]        # any CONFIRMED finding of these severities → Check Run fails
min_score: 70                    # below this → fail
ignore:                          # never review these paths
  - "**/*.generated.ts"
  - "docs/**"
path_instructions:               # CodeRabbit idea: per-folder review rules, added to the prompts
  - path: "src/auth/**"
    instructions: "Check token expiry and that signature algorithms are pinned (never 'none')."
  - path: "**/*.test.ts"
    instructions: "Only flag missing edge cases; ignore style."
```
```ts
const Policy = z.object({
  fail_on: z.array(z.enum(["critical", "high", "medium", "low"])).default(["critical"]),
  min_score: z.number().int().min(0).max(100).default(0),
  ignore: z.array(z.string()).default([]),
  path_instructions: z.array(z.object({ path: z.string(), instructions: z.string().max(1000) })).default([]),
});
// parse with the `yaml` package → Policy.safeParse → on error use defaults and add a warning to the report
// match paths with `minimatch`
```
> ⚠️ **Read the policy from the BASE branch, not the PR's head.** Otherwise a PR can relax its own rules (`fail_on: []`) and pass. Use `repos.getContent({ path: ".codeguard.yml", ref: baseSha })`.

### Build: the decision
```ts
const blocking = findings.filter((f) => f.verdict === "confirmed" && policy.fail_on.includes(f.severity));
const verdict = blocking.length > 0 || score < policy.min_score ? "fail" : "pass";
const reasons = [
  ...blocking.map((f) => `${f.severity} ${f.category} finding in ${f.file}:${f.line}`),
  ...(score < policy.min_score ? [`score ${score} is below min_score ${policy.min_score}`] : []),
];
// Check Run conclusion: pass → "success", fail → "failure".
// Teams make it BLOCK merges by marking the "CodeGuard AI" check as required in branch protection.
```
Fill the `assurance` object the review page already renders (`decision`, `scorecard`, `policies`, `risk`, `intent`, `verification`, `trace`). Store it as a `jsonb` column on `reviews`, because it's read whole and never filtered.

### ✅ Done when
- A planted false positive is **rejected** by the verifier and disappears from the comments.
- Changing `fail_on` on the **base** branch flips the Check Run; changing it **only in the PR** does not.
- A `path_instructions` rule visibly changes the comments on a matching file.

---

## 3.4 Recovery + trends + evals

### Concept: things that *will* go wrong
| Failure | Without a sweeper | Fix |
|---|---|---|
| Kafka down when a webhook arrived | Row stuck at `received` forever | **Outbox sweeper** republishes it |
| Worker killed mid-review (deploy, OOM) | Review stuck at `in_progress` forever, UI spinner never stops | **Stuck-review sweeper** requeues or fails it |
| A bug fails every attempt | Message in the DLQ | Fix the bug, then replay the DLQ |

### Build: sweepers (in the workers, `setInterval` with a little random jitter)
```ts
// Outbox sweeper: every 30 s
const rows = await db.execute(sql`
  SELECT id, delivery_id, event_type, action FROM webhook_events
  WHERE status = 'received' AND received_at < now() - interval '30 seconds'
  ORDER BY received_at LIMIT 50
  FOR UPDATE SKIP LOCKED`);            // two worker instances never grab the same rows
// → publish each → status = 'published'
// (run inside a transaction so the row locks hold until the update)
```
```ts
// Stuck-review sweeper: every 2 min (add an `attempts` int column to reviews)
UPDATE reviews SET status = 'pending', attempts = attempts + 1, progress = null
WHERE status = 'in_progress' AND updated_at < now() - interval '10 minutes' AND attempts < 3
RETURNING id, repo_full_name, pr_number, head_sha, installation_id;
// → republish review.requested for each; the worker must treat a 'pending' row it owns as resumable
// attempts >= 3 → status = 'failed', error = 'Timed out after 3 attempts'
```
> 💡 This is why every worker step updates `updated_at` (via `setProgress`): it's the heartbeat that tells the sweeper "still alive".

### Build: trends API
`GET /api/reviews/trends?days=30` → `{ scoreTrend: [{ date, avgScore, count }], categoryBreakdown: [{ category, severity, count }] }` (the shape `ReviewerDashboard.tsx` reads):
```sql
SELECT date_trunc('day', created_at)::date AS date, round(avg(score))::int AS "avgScore", count(*)::int AS count
FROM reviews WHERE status = 'completed' AND created_at > now() - make_interval(days => $1) AND repo_full_name = ANY($2)
GROUP BY 1 ORDER BY 1;

SELECT f.category, f.severity, count(*)::int AS count
FROM review_findings f JOIN reviews r ON r.id = f.review_id
WHERE r.created_at > now() - make_interval(days => $1) AND r.repo_full_name = ANY($2)
GROUP BY 1, 2;
```
(`$2` = the user's repos: always scope to what the user can see.)

### Build: a small eval set
Unit tests check **logic**; evals check **review quality**, which changes every time you touch a prompt, a model or the context.
```
apps/workers/evals/
  cases/jwt-none-alg.json      { "title", "files": [{ "path", "before", "after" }], "expected": [{ "file", "line", "category" }] }
  cases/sql-injection.json
  cases/missing-await.json
  cases/off-by-one.json
  cases/clean-refactor.json    expected: []  ← measures false positives
  harness.ts                   runs the pipeline with a fake GitHub (files from the case), scores the output
  baseline.json                last accepted scores
```
**Metrics:** recall = expected bugs found (same file, line ±3, same category); precision = reported findings that were expected; false positives on the clean case. Run `pnpm eval` before and after every prompt change and compare to `baseline.json`. **A prompt change without an eval run is a guess.**

### ✅ Done when
- Kill the worker mid-review (Ctrl+C), wait for the sweeper, restart it: the review still finishes.
- Stop Kafka, open a PR, start Kafka: the sweeper publishes the waiting row within a minute.
- `/reviews/trends` shows charts.
- `pnpm eval` prints recall/precision for 5 cases.

---

## Common mistakes on Day 3

| Symptom | Likely cause |
|---|---|
| `expected 384 dimensions, not 1536` | The embedding model doesn't match the `vector(N)` column; pick one and re-index |
| Vector search is slow | HNSW index missing, or the query isn't ordered by the **same** operator as the index (`vector_cosine_ops` ↔ `cosineDistance`) |
| Indexer hits `403 rate limit` | Too many `getBlob` calls; cap files, skip unchanged `blobSha`, back off on `x-ratelimit-reset` |
| Blast radius is always empty | Aliases like `@/…` aren't resolved, or extensions (`.ts`, `/index.ts`) aren't tried |
| Prompt too large / 413 | The context budget isn't enforced; drop RAG chunks first, never the diff |
| One reviewer's error kills the review | `Promise.all` instead of `Promise.allSettled` |
| A PR passes by editing `.codeguard.yml` | The policy was read from the head SHA instead of the base |
| Both sweepers process the same row | Missing `FOR UPDATE SKIP LOCKED`, or the select and update aren't in one transaction |
| Eval scores jump around | Temperature too high; use ~0.1 and run each case 2–3 times |

---

## End-of-day checklist

- [ ] `code_chunks` (vector + HNSW) and `code_files` migrated; full + incremental indexers
- [ ] RAG retrieval in the review prompt, excluding files already in the diff
- [ ] Import graph + reverse BFS blast radius + callers of changed functions
- [ ] Rule-based risk score with explainable factors
- [ ] Stage 1 → 2 → 3 (three parallel reviewers) with `progress` names the UI understands
- [ ] Merge + dedupe → verifier → confidence saved
- [ ] `.codeguard.yml` read from the **base** branch; `fail_on`, `min_score`, `ignore`, `path_instructions`
- [ ] Check Run conclusion comes from the policy; `assurance` filled for the review page
- [ ] Outbox and stuck-review sweepers (`SKIP LOCKED`, attempts cap)
- [ ] `/api/reviews/trends` works; the trends page renders
- [ ] Eval set with 5 cases and a baseline
- [ ] **From memory**, walk through `docs/HLD.md` §4 and name the file you wrote for each arrow

## Self-quiz

1. What does an embedding capture that keyword search can't? Give a code example.
2. Why exclude files that are already in the diff from the RAG results?
3. Draw the reverse import graph for: `a.ts → b.ts → c.ts`, `d.ts → c.ts`. What is the blast radius of changing `c.ts`?
4. Why is risk scored by code rather than asked of the LLM?
5. What does the verifier receive that the reviewer didn't focus on, and why is checking cheaper than finding?
6. Why must `.codeguard.yml` come from the base branch?
7. What does `FOR UPDATE SKIP LOCKED` prevent?
8. You change the security prompt and the eval recall drops from 0.8 to 0.6. What do you do?

**After the 3 days:** see "After the 3 days: more ideas from CodeRabbit" in the [roadmap](../ROADMAP-3-DAYS.md): learnings from feedback, past PRs as context, linked issues, sandbox verification, docs lookup for new APIs, and chat on review comments.
