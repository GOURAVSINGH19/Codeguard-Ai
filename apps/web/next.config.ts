import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  reactCompiler: true,

  // Required for pnpm monorepo on Vercel:
  // Tells Next.js to transpile shared workspace packages
  // instead of treating them as pre-built node_modules.
  transpilePackages: [
    "@codeguard/db",
    "@codeguard/types",
    "@codeguard/kafka",
    "@codeguard/config",
  ],

  // Ensure node/server dependencies are loaded properly in serverless environments
  serverExternalPackages: ["@neondatabase/serverless"],
};

export default nextConfig;
