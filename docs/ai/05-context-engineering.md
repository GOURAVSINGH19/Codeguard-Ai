# AI 5: Context engineering

⬅ [Embeddings and RAG](04-embeddings-and-rag.md) · Next ➡ [Blast radius](06-blast-radius.md)

> **In plain words:** context engineering is deciding **exactly what the model sees** for each call: which code, which facts, in what order, and how much. In CodeGuard it matters more than which model we use.

---

## 1. How it begins

All the prepare nodes ([Step 7](../steps/07-prepare-context.md)) exist to feed this. By the time a reviewer is called, the pipeline has collected **layers** of context:

| Layer | What it adds | Where it comes from |
|---|---|---|
| Team rules | Conventions, ignored paths, critical paths | `.codeguard.yml` from the **base** commit |
| PR intent | Why the PR exists; does the diff match? | Title, description, linked issues + one AI call |
| Annotated diff | The change, with new-file line numbers in a gutter | GitHub patches |
| Blast radius | Which files depend on the change, and how far away | Import graph ([page 6](06-blast-radius.md)) |
| Definitions | The code (and doc comments) of things the new lines use | Snapshot + import graph |
| Call sites | How *other* files call the changed functions, marked "NOT changed by this PR" | Snapshot + import graph |
| Similar code | Related code with no import link | RAG ([page 4](04-embeddings-and-rag.md)) |
| Skills | Short checklists for the detected stack (React, Kafka…) | Tech detection |
| Risk notes | "Risk is high because …" | Stage 2 |

## 2. What is important

**Each reviewer gets its own *pack*, not one shared prompt.**

| Pack | Budget (chars) | What comes first |
|---|---|---|
| align | 16,000 | Source files |
| quality | 28,000 | Source files + graph hotspots; related code + call sites |
| security | 24,000 | Files the scanner flagged, then auth/route/db/payment paths |
| testing | 16,000 | Test files, next to the code they cover |
| verify | 28,000 | Source files + related code |

**How a pack is filled** ([diff.ts](../../packages/review-engine/src/diff.ts)):

1. Order files by what matters to *this* reviewer.
2. Add **whole patches** from the top until the budget is full. Never cut a function in half.
3. Tell the model what was left out ("12 files omitted for budget").

**The annotated diff** puts the new-file line number in a left gutter, so the model reports lines GitHub can actually comment on:

```
<file path="auth/token.ts">
  1   import jwt from "jsonwebtoken";
  2 - const ALG = "RS256";
  2 + const ALG = process.env.JWT_ALG ?? "none";
</file>
```

**Code context catches what a diff can't show.** Two real eval cases:
- A function returns **cents**, but its caller formats it as **dollars**. The bug only shows if you see `formatMoney`'s doc comment, so we include **definitions**.
- A function gains a required parameter. An untouched file still calls it the old way. We include **call sites**, and a deterministic check flags the **breaking signature** (then the verifier double-checks it).

## 3. Why we use this

- **Garbage in, garbage out.** A strong model with the wrong context misses the real bug; a decent model with the right context finds it.
- **Budgets keep cost and latency predictable** and avoid the "lost in the middle" problem of huge prompts.
- **Per-reviewer packs** mean security sees auth code first instead of whatever file happened to be largest.
- **Old approach replaced:** the first version sent `diff.slice(0, 12000)`, cutting code mid-function and ignoring risk. Ranking + whole patches + "what was left out" notes fixed that.

## Known limits

- Definitions and call sites are found by **name** with text patterns, not by a type checker. Two functions with the same name can be confused; a language server would make it exact.
- Dynamic imports and dependency injection can hide edges from the graph.

## Code to read

[assurance/context.ts](../../packages/review-engine/src/assurance/context.ts) (packs, budgets) · [diff.ts](../../packages/review-engine/src/diff.ts) (annotated, budgeted diff) · [assurance/code-context.ts](../../packages/review-engine/src/assurance/code-context.ts) (definitions, call sites, breaking changes) · [nodes/code-context.ts](../../apps/workers/src/pipeline/nodes/code-context.ts)
