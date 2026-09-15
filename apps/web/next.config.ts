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

  // Silence the Vercel/Next.js warning about missing env vars at build time.
  // These are validated at runtime by each service that needs them.
  experimental: {
    serverComponentsExternalPackages: ["@neondatabase/serverless"],
  },
};

export default nextConfig;
