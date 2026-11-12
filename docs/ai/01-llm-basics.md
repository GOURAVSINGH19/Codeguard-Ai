# AI 1: LLM basics

⬅ [AI index](README.md) · Next ➡ [Prompts and prompt injection](02-prompts-and-injection.md)

> **In plain words:** a large language model (LLM) is a function: you give it text (a *prompt*), it gives back text. Everything else is about choosing *what* text to send and *checking* what comes back.

---

## 1. How it begins

Every AI step in CodeGuard goes through one small interface, `LLMProvider`, with one method: `completeJSON(messages)`. A message list looks like this:

```ts
[
  { role: "system", content: "You are CodeGuard's security reviewer. Return JSON shaped like …" },
  { role: "user",   content: "<untrusted-3f9a…> PR title, diff, related code … </untrusted-3f9a…>" },
]
```

- The **system** message holds *our* rules: the reviewer's role, what to look for, the output format.
- The **user** message holds the *data*: the PR and the code.

The provider is picked by one env var, `LLM_PROVIDER`: Groq and OpenAI share an OpenAI-compatible client; Anthropic has its own adapter. The pipeline code never knows which one it is talking to.

## 2. What is important

| Word | Simple meaning | In CodeGuard |
|---|---|---|
| **Token** | The unit a model reads and writes; roughly 4 characters of English or code | Usage is counted per review (`state.llm.usage`) |
| **Context window** | The most tokens a model can see at once | We never come close: each reviewer has a character budget ([page 5](05-context-engineering.md)) |
| **Temperature** | How random the answer is. 0 = most predictable | 0.2 for OpenAI-compatible providers, so the same PR gives similar results |
| **Latency** | Time to answer; grows with prompt and answer size | Parallel reviewers, 60 s timeout per call |
| **Cost** | You pay per input and output token | Budgets, ignore lists, incremental reviews, skipping unneeded calls |
| **Hallucination** | The model says something false, confidently | Grounding in real code, a verifier, schema checks |
| **Rate limit (429)** | The provider says "slow down" | Retries with exponential backoff + jitter, honouring `Retry-After` |

**Reliability rules every call follows** ([llm.ts](../../packages/review-engine/src/llm.ts)):

- A timeout, so a stuck call can't hang the review.
- Retries only for errors that may go away (408, 409, 429, 5xx, network), with growing waits plus random *jitter* so many workers don't retry at the same moment.
- Each provider only ever receives its **own** API key.

## 3. Why we use this

- **One interface, many providers.** We can swap models for price or quality, or compare them in [evals](08-evals.md), without touching pipeline code.
- **Low temperature** because a code reviewer should be consistent, not creative.
- **Why not just send the whole repo to a model with a 1-million-token window?** Cost and latency grow with tokens, and models get *worse* at spotting details in very long prompts (the "lost in the middle" effect). Small, targeted prompts are cheaper and usually more accurate.

## Common questions

- **Is the model deterministic?** No. Even at low temperature, two runs can differ. Deduplication, the verifier and code-based policy keep the final result stable.
- **Does the model remember previous reviews?** No. Each call starts fresh. Anything it should know must be in the prompt.

## Code to read

[llm.ts](../../packages/review-engine/src/llm.ts) · [anthropic.ts](../../packages/review-engine/src/anthropic.ts) · [provider.ts](../../packages/review-engine/src/provider.ts) · [llm.test.ts](../../packages/review-engine/src/__tests__/llm.test.ts)
