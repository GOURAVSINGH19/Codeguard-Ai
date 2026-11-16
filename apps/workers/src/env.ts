import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * Load env BEFORE anything else is imported (index.ts imports this first).
 * The workers share the web app's env file, so there's one place for secrets.
 * The first file that defines a variable wins.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
config({
  path: [
    path.resolve(here, "../.env"),
    path.resolve(here, "../../web/.env.local"),
    path.resolve(here, "../../web/.env"),
  ],
  quiet: true,
});
