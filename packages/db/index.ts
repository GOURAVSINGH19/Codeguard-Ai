export { db, type DB } from "./client";
export * from "./schema";
// Re-export query helpers so apps don't need their own drizzle-orm dependency.
export { eq, ne, and, or, not, inArray, isNull, isNotNull, desc, asc, sql, count, gte, lt, ilike, exists } from "drizzle-orm";
export type { SQL } from "drizzle-orm";
