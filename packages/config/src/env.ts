import { z } from "zod";

/**
 * Single source of truth for every environment variable CodeGuard AI reads.
 *
 * - Everything is optional at the schema level so the Next.js build and unit
 *   tests can run without real secrets. Features that need a value call one of
 *   the `require*()` helpers below, which fail fast with a clear message.
 * - Values are parsed once and cached. Call `resetEnvCache()` in tests after
 *   mutating `process.env`.
 */

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== "" ? v.trim() : undefined));

const booleanString = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === "" ? defaultValue : v.trim().toLowerCase() === "true"));

export const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  // ── Database ────────────────────────────────────────────────────────────
  DATABASE_URL: optionalString,

  // ── LLM ─────────────────────────────────────────────────────────────────
  /** Which chat-completions provider to use for reviews. */
  LLM_PROVIDER: z.enum(["groq", "openai"]).default("groq"),
  /** Overrides the provider's default model. `GROQ_MODEL` is still honoured for Groq. */
  LLM_MODEL: optionalString,
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  GROQ_API_KEY: optionalString,
  GROQ_MODEL: optionalString,
  OPENAI_API_KEY: optionalString,
  OPENAI_MODEL: optionalString,
  /** Embeddings always use OpenAI (text-embedding-3-small). */
  EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),

  // ── GitHub App ──────────────────────────────────────────────────────────
  GITHUB_APP_ID: optionalString,
  GITHUB_APP_SLUG: z.string().default("codeguard-ai"),
  /** PEM. Literal "\n" sequences (common in dashboards) are converted to newlines. */
  GITHUB_APP_PRIVATE_KEY: optionalString.transform((v) => v?.replace(/\\n/g, "\n")),
  GITHUB_APP_CLIENT_ID: optionalString,
  GITHUB_APP_CLIENT_SECRET: optionalString,
  GITHUB_APP_WEBHOOK_SECRET: optionalString,
  /** Secret for the legacy repository webhook route (/api/webhooks/github). */
  GITHUB_WEBHOOK_SECRET: optionalString,

  // ── Kafka ───────────────────────────────────────────────────────────────
  KAFKA_BROKERS: optionalString,
  KAFKA_HOST: optionalString,
  KAFKA_PORT: z.coerce.number().int().positive().default(9092),
  KAFKA_USERNAME: optionalString,
  KAFKA_PASSWORD: optionalString,
  KAFKA_SASL_MECHANISM: z.enum(["plain", "scram-sha-256", "scram-sha-512"]).default("scram-sha-256"),
  /** TLS for SASL connections. On by default. */
  KAFKA_SSL: booleanString(true),
  /** Verify the broker certificate. On by default — only disable for local dev. */
  KAFKA_SSL_REJECT_UNAUTHORIZED: booleanString(true),

  // ── App ─────────────────────────────────────────────────────────────────
  NEXT_PUBLIC_APP_URL: optionalString,
  /** Max AI reviews a single user can start per hour (snippet + PR). */
  REVIEW_RATE_LIMIT_PER_HOUR: z.coerce.number().int().positive().default(30),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

export function getEnv(): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  cached = parsed.data;
  return cached;
}

/** Tests only: forget the parsed env so the next `getEnv()` re-reads process.env. */
export function resetEnvCache(): void {
  cached = null;
}

export class MissingConfigError extends Error {
  constructor(names: string[], feature: string) {
    super(`${feature} is not configured. Set ${names.join(", ")} in your environment.`);
    this.name = "MissingConfigError";
  }
}

function need<K extends keyof Env>(env: Env, keys: K[], feature: string) {
  const missing = keys.filter((k) => env[k] === undefined || env[k] === "");
  if (missing.length > 0) throw new MissingConfigError(missing as string[], feature);
}

// ── Feature-level accessors ───────────────────────────────────────────────

export interface LLMConfig {
  provider: "groq" | "openai";
  apiKey: string;
  model: string;
  baseUrl: string;
  timeoutMs: number;
}

const PROVIDER_DEFAULTS = {
  groq: { baseUrl: "https://api.groq.com/openai/v1", model: "openai/gpt-oss-120b" },
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini" },
} as const;

/**
 * Resolve the review LLM. Each provider only ever uses its OWN key — an OpenAI
 * key is never sent to Groq (or vice versa).
 */
export function getLLMConfig(env: Env = getEnv()): LLMConfig {
  const provider = env.LLM_PROVIDER;
  if (provider === "groq") {
    need(env, ["GROQ_API_KEY"], "The Groq review model (LLM_PROVIDER=groq)");
    return {
      provider,
      apiKey: env.GROQ_API_KEY!,
      model: env.LLM_MODEL ?? env.GROQ_MODEL ?? PROVIDER_DEFAULTS.groq.model,
      baseUrl: PROVIDER_DEFAULTS.groq.baseUrl,
      timeoutMs: env.LLM_TIMEOUT_MS,
    };
  }
  need(env, ["OPENAI_API_KEY"], "The OpenAI review model (LLM_PROVIDER=openai)");
  return {
    provider,
    apiKey: env.OPENAI_API_KEY!,
    model: env.LLM_MODEL ?? env.OPENAI_MODEL ?? PROVIDER_DEFAULTS.openai.model,
    baseUrl: PROVIDER_DEFAULTS.openai.baseUrl,
    timeoutMs: env.LLM_TIMEOUT_MS,
  };
}

export interface GitHubAppConfig {
  appId: string;
  privateKey: string;
  slug: string;
  clientId?: string;
  clientSecret?: string;
  webhookSecret?: string;
}

export function getGitHubAppConfig(env: Env = getEnv()): GitHubAppConfig {
  need(env, ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY"], "The GitHub App");
  return {
    appId: env.GITHUB_APP_ID!,
    privateKey: env.GITHUB_APP_PRIVATE_KEY!,
    slug: env.GITHUB_APP_SLUG,
    clientId: env.GITHUB_APP_CLIENT_ID,
    clientSecret: env.GITHUB_APP_CLIENT_SECRET,
    webhookSecret: env.GITHUB_APP_WEBHOOK_SECRET,
  };
}

/** OAuth credentials needed to verify who completed a GitHub App install. */
export function getGitHubAppOAuthConfig(env: Env = getEnv()) {
  need(env, ["GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET"], "GitHub App user authorization");
  return { clientId: env.GITHUB_APP_CLIENT_ID!, clientSecret: env.GITHUB_APP_CLIENT_SECRET! };
}

export interface KafkaConfig {
  brokers: string[];
  sasl?: { mechanism: Env["KAFKA_SASL_MECHANISM"]; username: string; password: string };
  ssl: boolean | { rejectUnauthorized: boolean };
  logLevel: Env["LOG_LEVEL"];
}

export function getKafkaConfig(env: Env = getEnv()): KafkaConfig {
  let brokers: string[];
  if (env.KAFKA_BROKERS) {
    brokers = env.KAFKA_BROKERS.split(",").map((b) => b.trim()).filter(Boolean);
  } else if (env.KAFKA_HOST) {
    brokers = [`${env.KAFKA_HOST}:${env.KAFKA_PORT}`];
  } else {
    brokers = ["localhost:19092"];
  }

  const hasSasl = Boolean(env.KAFKA_USERNAME && env.KAFKA_PASSWORD);
  return {
    brokers,
    sasl: hasSasl
      ? { mechanism: env.KAFKA_SASL_MECHANISM, username: env.KAFKA_USERNAME!, password: env.KAFKA_PASSWORD! }
      : undefined,
    // TLS is on whenever credentials are used, and certificates are verified
    // unless KAFKA_SSL_REJECT_UNAUTHORIZED=false is set explicitly.
    ssl: hasSasl && env.KAFKA_SSL ? { rejectUnauthorized: env.KAFKA_SSL_REJECT_UNAUTHORIZED } : false,
    logLevel: env.LOG_LEVEL,
  };
}

export function isProduction(env: Env = getEnv()): boolean {
  return env.NODE_ENV === "production";
}
