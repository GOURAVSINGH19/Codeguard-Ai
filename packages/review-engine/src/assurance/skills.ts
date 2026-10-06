import type { TechnologyProfile } from "./technology";

/**
 * resolve_skills: a skill is a focused review checklist for one technology,
 * fed to the stage that owns it. Skills keep prompts short and specific: a
 * Python PR doesn't get React advice, a Kafka consumer gets offset/retry checks.
 */
export interface ReviewSkill {
  id: string;
  title: string;
  stage: "quality" | "security" | "testing";
  /** Short imperative checks, one per line in the prompt. */
  checks: string[];
  appliesTo: (tech: TechnologyProfile) => boolean;
}

const has = (tech: TechnologyProfile, ...names: string[]) => names.some((n) => tech.frameworks.includes(n) || tech.languages.some((l) => l.name === n));

export const SKILL_REGISTRY: ReviewSkill[] = [
  {
    id: "general-correctness",
    title: "General correctness",
    stage: "quality",
    appliesTo: () => true,
    checks: [
      "Edge cases: empty inputs, null/undefined, zero, very large values, unicode.",
      "Error paths: errors are handled or propagated, never silently swallowed.",
      "Resource handling: connections, files, timers and subscriptions are released.",
      "Concurrency: shared state, races between async operations, idempotency of retries.",
    ],
  },
  {
    id: "typescript",
    title: "TypeScript",
    stage: "quality",
    appliesTo: (t) => has(t, "TypeScript"),
    checks: [
      "No `any`/non-null `!` hiding a real nullable value; narrow types instead.",
      "Promises are awaited or deliberately detached; no floating promises in loops.",
      "Exhaustive handling of union types (switch with a never check).",
    ],
  },
  {
    id: "react",
    title: "React",
    stage: "quality",
    appliesTo: (t) => has(t, "React"),
    checks: [
      "Hook rules: hooks are not called conditionally; effect dependency arrays are complete.",
      "Effects that subscribe or fetch clean up and ignore stale responses.",
      "List items have stable keys; no state derived from props without a reason.",
    ],
  },
  {
    id: "nextjs",
    title: "Next.js",
    stage: "security",
    appliesTo: (t) => has(t, "Next.js"),
    checks: [
      "Route handlers and server actions check authentication and authorization themselves.",
      "Secrets are never exposed through NEXT_PUBLIC_ variables or client components.",
      "User input to route handlers is validated (e.g. with Zod) before use.",
    ],
  },
  {
    id: "node-server",
    title: "Node.js services",
    stage: "security",
    appliesTo: (t) => has(t, "Express", "Fastify", "NestJS", "Hono", "Koa", "Next.js"),
    checks: [
      "Every endpoint enforces auth and checks the caller owns the resource (IDOR).",
      "Inputs are validated; outbound requests to user-supplied URLs are restricted (SSRF).",
      "Error responses don't leak stack traces, SQL or upstream error bodies.",
    ],
  },
  {
    id: "sql-orm",
    title: "Databases & ORMs",
    stage: "quality",
    appliesTo: (t) => has(t, "Drizzle ORM", "Prisma", "TypeORM", "Sequelize", "SQLAlchemy", "Django", "SQL"),
    checks: [
      "Queries are parameterized; raw SQL never concatenates input.",
      "Multi-step writes that must succeed together run in a transaction.",
      "Migrations are backwards compatible with the running code (no drop/rename before deploy).",
      "No N+1 queries in loops; new filters on large tables have an index.",
    ],
  },
  {
    id: "kafka-consumer",
    title: "Message consumers",
    stage: "quality",
    appliesTo: (t) => has(t, "Kafka", "Celery"),
    checks: [
      "Handlers are idempotent: a redelivered message must not duplicate side effects.",
      "Poison messages go to a dead-letter path instead of blocking the partition.",
      "Long handlers heartbeat; ordering assumptions match the message key.",
    ],
  },
  {
    id: "llm-integration",
    title: "LLM integrations",
    stage: "security",
    appliesTo: (t) => has(t, "OpenAI SDK", "Anthropic SDK"),
    checks: [
      "Untrusted text sent to a model is delimited and can't override instructions (prompt injection).",
      "Model output is validated before it drives actions, queries or HTML.",
      "Timeouts, retries and token limits are set; API keys stay server-side.",
    ],
  },
  {
    id: "python",
    title: "Python",
    stage: "quality",
    appliesTo: (t) => has(t, "Python"),
    checks: [
      "No mutable default arguments; exceptions are not caught with a bare `except:`.",
      "Files and connections use context managers.",
      "Type hints match behaviour; None is handled where Optional is declared.",
    ],
  },
  {
    id: "python-web",
    title: "Python web frameworks",
    stage: "security",
    appliesTo: (t) => has(t, "Django", "Flask", "FastAPI"),
    checks: [
      "Views check permissions; CSRF protection stays on for state-changing requests.",
      "ORM `raw`/`extra`/text queries don't interpolate input.",
      "DEBUG and secret keys come from the environment.",
    ],
  },
  {
    id: "go",
    title: "Go",
    stage: "quality",
    appliesTo: (t) => has(t, "Go"),
    checks: [
      "Every returned error is checked; errors are wrapped with context.",
      "Goroutines can exit (context cancellation); no unbounded goroutine creation.",
      "Shared maps/slices are protected; `defer` inside loops is avoided.",
    ],
  },
  {
    id: "secrets-hygiene",
    title: "Secrets & credentials",
    stage: "security",
    appliesTo: () => true,
    checks: [
      "No credentials, tokens or private keys in code, config or tests.",
      "Sensitive values are not logged or returned in API responses.",
    ],
  },
  {
    id: "testing-discipline",
    title: "Testing",
    stage: "testing",
    appliesTo: () => true,
    checks: [
      "New behaviour has a test that would fail without the change.",
      "Tests assert outcomes, not implementation details; no sleeps or real network calls.",
    ],
  },
];

export interface ResolvedSkills {
  quality: ReviewSkill[];
  security: ReviewSkill[];
  testing: ReviewSkill[];
  ids: string[];
}

export function resolveSkills(tech: TechnologyProfile, config: { enable: string[]; disable: string[] }): ResolvedSkills {
  const disabled = new Set(config.disable);
  const enabled = new Set(config.enable);
  const active = SKILL_REGISTRY.filter((s) => !disabled.has(s.id) && (enabled.has(s.id) || s.appliesTo(tech)));
  return {
    quality: active.filter((s) => s.stage === "quality"),
    security: active.filter((s) => s.stage === "security"),
    testing: active.filter((s) => s.stage === "testing"),
    ids: active.map((s) => s.id),
  };
}

export function formatSkills(skills: ReviewSkill[]): string {
  return skills.map((s) => `${s.title}:\n${s.checks.map((c) => `- ${c}`).join("\n")}`).join("\n\n");
}
