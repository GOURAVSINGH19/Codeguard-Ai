import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import ws from "ws";
import * as schema from "./schema";

/**
 * Neon's serverless driver over WebSockets.
 *
 * Why this and not `neon-http`: the WebSocket Pool behaves like normal `pg` and
 * supports interactive transactions, which Day 2 needs (update a review and
 * insert its findings atomically).
 *
 * Node (Next.js API routes, workers) needs a WebSocket implementation for this
 * driver, so we hand it the `ws` package.
 */
neonConfig.webSocketConstructor = ws;

// Pooled Neon string. The Pool connects lazily on the first query, so importing
// this file during `next build` without env vars is fine.
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export const db = drizzle({ client: pool, schema });
export type DB = typeof db;
