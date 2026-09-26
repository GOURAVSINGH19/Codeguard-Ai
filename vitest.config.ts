import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["**/__tests__/**/*.test.ts", "**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.next/**"],
    reporters: ["verbose"],
    globals: true,
    // Tests must never depend on a developer's real environment.
    env: { NODE_ENV: "test" },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "apps/web/src"),
      "@codeguard/types": path.resolve(__dirname, "packages/types/src/index.ts"),
      "@codeguard/db": path.resolve(__dirname, "packages/db/index.ts"),
      "@codeguard/kafka": path.resolve(__dirname, "packages/kafka/src/index.ts"),
      "@codeguard/config": path.resolve(__dirname, "packages/config/src/index.ts"),
      "@codeguard/review-engine": path.resolve(__dirname, "packages/review-engine/src/index.ts"),
    },
  },
});
