# AI 9: Pipeline vs agent

⬅ [Evals](08-evals.md) · Back to the [AI index](README.md)

> **In plain words:** an *agent* is an AI in a loop that decides its own next step and can use tools (open a file, run a test). A *pipeline* is a fixed list of steps written in code, where the AI only fills in specific blanks. CodeGuard is a pipeline, **on purpose**.

---

## 1. How it begins

The whole review is one ordered list of 24 nodes in [reviewPipeline.ts](../../apps/workers/src/pipeline/reviewPipeline.ts), run by a tiny runner ([runner.ts](../../packages/review-engine/src/assurance/runner.ts)):

```
prepare (12 nodes) → stage 1 → stage 2 → stage 3
→ aggregate → dedupe → plan → verify → scorecard → policy → decision → insights → publish
```

- Steps run **in order**. A **group** runs its steps in parallel (`Promise.allSettled`, so all finish even if one fails), then an optional **join** step combines them.
- Each step is **required** (failure fails the run, and Kafka retries) or **optional** (failure is noted and skipped).
- Only six steps call a model (intent, align, quality, security, testing, verify). Everything else is plain, tested code.

## 2. What is important

| | Pipeline (CodeGuard) | Agent |
|---|---|---|
| Who decides the next step? | The code | The model |
| Cost per review | Predictable (≤ 6 model calls) | Varies; can loop |
| Testing | Each step is unit-tested | Hard to test end to end |
| Debugging | A trace shows exactly which step did what | "Why did it do that?" |
| Safety | The model has **no tools** and can't act | Tools can be misused if it's hijacked |
| Flexibility | Only the paths we wrote | Can follow a lead it discovers |

**Parallel specialists** (quality, security, testing) are sometimes called "multi-agent". Here they are simply focused prompts run side by side, then merged and judged.

## 3. Why we use this

The steps of a good code review are **known in advance**: understand the change, measure risk, review, check the findings, apply the rules. When the path is known, a pipeline is cheaper, more reliable and easier to explain. And because the model can't take actions, a prompt injection can at worst produce a bad finding, which the verifier and policy then filter.

**When an agent would help:** when the right next step depends on what you find, for example "this finding depends on how `getUser` handles nulls; open that file". A safe middle ground is a pipeline with **small, bounded agentic steps**: let the verifier call a read-only `read_file` or `find_references` tool, with a step limit.

## Code to read

[reviewPipeline.ts](../../apps/workers/src/pipeline/reviewPipeline.ts) · [runner.ts](../../packages/review-engine/src/assurance/runner.ts) · [state.ts](../../apps/workers/src/pipeline/state.ts) (what each step reads and writes)
