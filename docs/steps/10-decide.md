# Step 10: Score, policy and the decision

> **In one line:** turn the findings into a 0–10 scorecard, apply the team's rules from `.codeguard.yml`, and decide **approve / comment / request changes**, which becomes the Check Run's **success / neutral / failure**.

⬅ [Step 9](09-verify-findings.md) · Next ➡ [Step 11: Publish to GitHub](11-publish.md)

---

## 1. How this step begins

With the final list of findings ready, three plain-code nodes run (no AI):

```
scorecard → policy_evaluation → assurance_decision
```

**Scorecard.** Six dimensions, each scored 0–10 and weighted:

| Dimension | Weight | Based on |
|---|---|---|
| Code quality | 25% | Quality findings (severity × confidence) |
| Security | 25% | Security findings |
| Testing | 15% | Untested source files, failing CI checks |
| Matches stated intent | 15% | The alignment score (skipped if the PR has no description) |
| Scope & cohesion | 10% | Size of the PR and how many unrelated change groups it has |
| Change risk | 10% | The risk score from stage 2 |

**Policy.** Rules the team sets in `.codeguard.yml` (defaults shown):

```yaml
fail_on: critical          # any finding at/above this severity fails ("never" = never block)
min_severity: low          # findings below this are not posted
policy:
  block_secrets: true      # a detected credential fails the check
  require_tests: warn      # off | warn | block: source changed but no tests
  max_changed_lines: 800   # bigger PRs get a warning
  min_score: null          # optional: overall score below this fails
  min_confidence: 0.5      # less confident findings are not posted
```

A first-time contributor touching critical paths also gets a "needs a maintainer" note.

**Decision.**

| Result | Verdict | Check Run |
|---|---|---|
| Any policy rule fails | request changes | ❌ failure |
| Notes or warnings, but nothing blocking | comment | ⚪ neutral |
| Clean | approve | ✅ success |

## 2. What is important

- **The AI gives opinions; code decides the gate.** Pass or fail comes from deterministic rules, not from the model.
- **Every failure has a named reason** ("secret detected in `config.ts`", "critical finding"), so the result is explainable.
- **The policy is read from the base branch** ([Step 7](07-prepare-context.md)), so a PR can't relax its own rules.

## 3. Why we use this

Teams need a gate that is **predictable**. If a model alone decided, the same PR could pass once and fail the next time, and a prompt injection could try to flip the result. Because the gate is ordinary code driven by the team's written rules, it behaves the same every time and can't be argued with by PR text.

## What can go wrong

| Situation | What happens |
|---|---|
| Team never wants the bot to block | `fail_on: never` |
| A PR edits `.codeguard.yml` to be more lenient | Ignored until merged: policy comes from the base branch |
| Secret found in a test fixture or `.example` file | Lower-trust paths and placeholders like `changeme` reduce false alarms |

## Code to read

- [assurance/decision.ts](../../packages/review-engine/src/assurance/decision.ts) (scorecard, policy, verdict)
- [repo-config.ts](../../packages/review-engine/src/repo-config.ts) (`.codeguard.yml` schema and defaults)
- [assurance/risk.ts](../../packages/review-engine/src/assurance/risk.ts) (risk level)
