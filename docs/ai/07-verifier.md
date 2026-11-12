# AI 7: The verifier (LLM-as-a-judge)

⬅ [Blast radius](06-blast-radius.md) · Next ➡ [Evals](08-evals.md)

> **In plain words:** one AI call *finds* problems; a second, separate AI call *checks* them, like a senior engineer reviewing a junior's review comments before they're posted.

---

## 1. How it begins

After the reviewers finish and duplicates are merged ([Step 9](../steps/09-verify-findings.md)), the `independent_verify` node sends the verifier:

- the same annotated diff and related code (the verify pack),
- the findings, numbered, one JSON object per line,
- strict rules for each verdict.

```
For each numbered finding, decide whether the diff really shows the problem.
- "confirmed":  the problem is visible in the changed lines, at that file and line.
- "rejected":   not in the code, about unchanged code, a duplicate, or a guess.
- "uncertain":  could be real, but depends on code that isn't shown.
Do not add new findings.
```

It returns `{ "verdicts": [ { "id": 0, "verdict": "confirmed", "reason": "…" }, … ] }`.

## 2. What is important

| Verdict | What happens to the finding |
|---|---|
| confirmed | Kept; confidence raised to at least 0.9 |
| uncertain | Kept, but **one severity lower** (e.g. high → medium) |
| *no verdict at all* | Treated as uncertain: silence isn't proof it's wrong |
| rejected | Removed; the reason is saved for transparency |

- **Only confirmed findings can fail the Check Run on their own.**
- **The verifier can't add findings.** Its only job is judging, which keeps it focused.
- **Scanner hits with high confidence skip it**: a matched secret pattern doesn't need an AI opinion.
- **Cost cap:** at most 25 findings are verified (most severe first); the rest are marked unverified with lower confidence.
- **Fail-safe:** if the verifier call fails, findings are kept as "unverified" instead of losing the review.
- **Same injection guard** as every other prompt ([page 2](02-prompts-and-injection.md)).

## 3. Why we use this

- Reviewers are told to be thorough, so they **over-report**. Thoroughness and precision pull in opposite directions; splitting them into two calls lets each be good at one thing.
- **False positives kill review bots.** After a few wrong comments, developers ignore all of them.
- **Measured, not assumed:** in the eval harness the verifier raised precision from **47% to 80%** while recall stayed at **100%** ([page 8](08-evals.md)).

## Known risks

- **Self-agreement.** If the verifier is the same model as the reviewer, it may share its blind spots. Mitigated by a different, stricter prompt and fresh context; a different model family as judge would be better.
- **It can only judge what it sees.** A verifier that could look things up (open a file, find references) would be stronger. That's a possible next step, with strict limits.

## Code to read

[verify.ts](../../packages/review-engine/src/verify.ts) (prompt + schema) · [assurance/findings.ts](../../packages/review-engine/src/assurance/findings.ts) (`planVerification`, verdicts) · [nodes/findings.ts](../../apps/workers/src/pipeline/nodes/findings.ts)
