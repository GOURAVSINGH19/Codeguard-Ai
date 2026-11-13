import { z } from "zod";

/**
 * Every environment variable the backend needs, checked once.
 *
 * Why: a missing secret should fail loudly at startup, not at 2 a.m. when the
 * first webhook arrives. Zod also gives us typed values (string, not
 * string | undefined).
 *
 * Clerk keys are NOT here: @clerk/nextjs reads them itself.
 */
const EnvSchema = z.object({
  // Neon pooled connection string (host contains "-pooler"), used by the app.
  DATABASE_URL: z.url(),
  // Neon direct connection string, used only by drizzle-kit migrations.
  DATABASE_URL_UNPOOLED: z.url().optional(),

  // Day 2
  KAFKA_BROKERS: z.string().default("localhost:9092"),

  // Day 1.3 / 1.4
  GITHUB_APP_ID: z.string().min(1),
  GITHUB_APP_SLUG: z.string().min(1),
  GITHUB_PRIVATE_KEY: z.string().min(1),
  GITHUB_WEBHOOK_SECRET: z.string().min(16, "use a long random string (16+ chars)"),

  // Day 2: the AI model. Only the chosen provider's key is required (checked in review-engine).
  LLM_PROVIDER: z.enum(["groq", "openai"]).default("groq"),
  LLM_MODEL: z.string().min(1).optional(),
  GROQ_API_KEY: z.string().min(1).optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  // Public URL of the web app, used for "Open the full review" links on GitHub.
  APP_URL: z.url().optional(),
  // Token budget for the diff part of the prompt.
  REVIEW_MAX_DIFF_TOKENS: z.coerce.number().int().min(1000).default(12000),
});

export type Env = z.infer<typeof EnvSchema>;

/** Thrown when env is invalid; API routes can turn it into a safe 500. */
export class MissingConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid environment variables:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "MissingConfigError";
  }
}

let cached: Env | undefined;

/** Parse and cache process.env. Throws MissingConfigError listing every problem at once. */
export function getEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached && source === process.env) return cached;

  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new MissingConfigError(
      parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    );
  }

  const env: Env = {
    ...parsed.data,
    // .env files can't hold real newlines, so the PEM key is stored with "\n".
    GITHUB_PRIVATE_KEY: parsed.data.GITHUB_PRIVATE_KEY.replace(/\n/g, "\n"),
  };
  if (source === process.env) cached = env;
  return env;
}
