import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    // Use the "node" environment — no DOM needed for service/unit tests
    environment: "node",
    // Glob pattern picks up all test files across the monorepo
    include: ["**/__tests__/**/*.test.ts", "**/*.test.ts"],
    // Exclude node_modules and built output
    exclude: ["**/node_modules/**", "**/dist/**", "**/.next/**"],
    // Print a coverage-style summary after each run
    reporters: ["verbose"],
    // Global setup: make vi available without importing it everywhere
    globals: true,
  },
  resolve: {
    alias: {
      // Let web app tests resolve @/ imports
      "@": path.resolve(__dirname, "apps/web/src"),
      // Let all tests resolve workspace packages
      "@codeguard/types": path.resolve(__dirname, "packages/types/src/index.ts"),
      "@codeguard/db": path.resolve(__dirname, "packages/db/index.ts"),
      "@codeguard/kafka": path.resolve(__dirname, "packages/kafka/src/index.ts"),
    },
  },
});
