import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

// Reuse the web app's env file. The first file that defines a variable wins.
config({ path: ["../../apps/web/.env.local", "../../apps/web/.env"], quiet: true });

const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!url) throw new Error("Set DATABASE_URL_UNPOOLED (or DATABASE_URL) in apps/web/.env.local");

export default defineConfig({
  schema: "./schema/index.ts",
  out: "./migrations",
  dialect: "postgresql",
  // Migrations need a real session, so use Neon's DIRECT string, not the "-pooler" one.
  dbCredentials: { url },
  strict: true,
  verbose: true,
});
