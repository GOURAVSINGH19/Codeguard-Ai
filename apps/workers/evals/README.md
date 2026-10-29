# Review eval

Measures how good CodeGuard's reviews are: **did it find the bug (recall), and was what it reported real (precision)?**

```bash
pnpm eval
```

It uses the model from your `.env` (`LLM_PROVIDER`, `LLM_MODEL` and that provider's key). It needs no database, Kafka or GitHub.

## What it runs

Each case in [`cases/`](cases) is a small PR (title, description, unified-diff patches) plus the bugs planted in it. The harness ([`src/evals/harness.ts`](../src/evals/harness.ts)) runs the **real** pipeline nodes on it: intent → stage 1 → stage 2 → stage 3 → aggregate → dedupe → plan → independent verify.

RAG is not run, because it needs embeddings of a real repository. A case can give the rest of the repo, though:

- `files[].content`: the full file at the PR head.
- `repoFiles`: other files the PR doesn't change, such as callers and imported types.

With these, the harness builds the import graph and runs `build_code_context`, just as the worker does on an indexed repo. That step adds definitions of what the diff uses, call sites of changed functions, and breaking-change findings. The `code-context` tag marks the cases that need it (`pnpm eval --tag code-context`).

## How a finding is scored

| Result | Rule |
|---|---|
| **True positive** | Same file, line inside the expected range ± 3 (`--tolerance`). Each bug is matched once, by the closest finding. |
| **Duplicate** | Another finding near a bug that was already matched. Reported, not counted as wrong. |
| **False positive** | Any other finding with a file. Every finding on a clean PR is one. |
| **Blocking false positive** | A false positive at high/critical severity, the kind that could wrongly fail a Check Run. |
| **Not scored** | PR-level findings with no file (size, missing tests). They can't be placed against a line. |

Precision and recall are micro-averaged over all cases. Every run is scored twice: **before verify** and **final**. The difference is what the verifier is worth.

**Degraded cases are left out.** If any model call in a case fails (rate limit, timeout, bad output), the case is marked `DEGRADED` and kept out of the totals. Some reviewers catch their own errors and keep only the deterministic findings, so without this a rate limit would look like a missed bug. A run with degraded cases exits 1 and never updates the baseline. Error text is redacted (account ids) and shortened before it's saved.

**Rate limits.** Cases run one at a time by default. On a small tokens-per-minute limit (Groq's free tier is 8,000), add a pause: `pnpm eval --pause 15`.

## Output

- A table per case (TP/FP/FN, the verifier's confirmed / uncertain / rejected counts, every miss and false positive), then totals.
- `results/<time>-<provider>-<model>.json` with everything (gitignored).
- `--update-baseline` saves the run as `baseline.json`. Commit it. Later runs exit 1 if precision or recall drops more than 5 points (`--max-drop`), or if blocking false positives rise. CI's **Review Eval** job uses this on pull requests when `GROQ_API_KEY` is set.

## Adding a case

1. Copy a file in `cases/`. The `id` must equal the file name.
2. Put the PR's patches in `files` and the bug's new-file line range in `expected`. Use `expected: []` for a clean PR.
3. Run `pnpm test`. [`cases.test.ts`](../src/evals/__tests__/cases.test.ts) checks the hunk headers and that each expected range covers an added line.

The best source of real cases is bug-fix commits: the commit **before** the fix contains the bug, and the fix tells you where it is.

## Useful flags

```bash
pnpm eval --tag security          # only security cases
pnpm eval --case sec-sql-injection
pnpm eval --verbose               # show pipeline warnings
LLM_PROVIDER=anthropic pnpm eval  # compare models
```
