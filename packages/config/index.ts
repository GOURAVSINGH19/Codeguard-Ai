import { z } from "zod";

const EnvSchema = z.object({
  DATABASE_URL: z.string().url(),                 
  DATABASE_URL_UNPOOLED: z.string().url().optional(), // Neon direct string: used only by migrations
  KAFKA_BROKERS: z.string().default("localhost:9092"),
  GITHUB_APP_ID: z.string().min(1),
  GITHUB_APP_SLUG: z.string().min(1),          // used to build the install URL
  GITHUB_PRIVATE_KEY: z.string().min(1),
  GITHUB_WEBHOOK_SECRET: z.string().min(16),
});

export type Env = z.infer<typeof EnvSchema>;
let cached: Env | undefined;

export function getEnv(): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(
    (globalThis as typeof globalThis & { process?: { env: Record<string, string | undefined> } }).process?.env ?? {},
  );
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid environment variables:\n${problems.join("\n")}`);
  }
  cached = { ...parsed.data, GITHUB_PRIVATE_KEY: parsed.data.GITHUB_PRIVATE_KEY.replace(/\\n/g, "\n") };
  return cached;
}