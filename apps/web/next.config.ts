import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,

  // Workspace packages ship TypeScript source, so Next.js must compile them.
  transpilePackages: ["@codeguard/config", "@codeguard/db", "@codeguard/kafka", "@codeguard/review-engine"],

  // Node-only libraries that must load as real Node modules, not bundled.
  serverExternalPackages: ["@neondatabase/serverless", "ws", "kafkajs"],
};

export default nextConfig;
