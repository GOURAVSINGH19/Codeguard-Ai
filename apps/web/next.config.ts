import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,

  // Workspace packages ship TypeScript source, so Next.js must compile them.
  transpilePackages: ["@codeguard/config", "@codeguard/db"],

  // Neon's WebSocket driver and `ws` must load as real Node modules, not bundled.
  serverExternalPackages: ["@neondatabase/serverless", "ws"],
};

export default nextConfig;
