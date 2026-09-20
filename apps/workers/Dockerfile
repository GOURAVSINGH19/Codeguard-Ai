# ── Stage 1: Dependencies ────────────────────────────────────────────────────
FROM node:22-slim AS deps

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm@10.12.4

# Copy workspace manifests needed for pnpm to resolve workspace packages
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/db/package.json         ./packages/db/package.json
COPY packages/kafka/package.json      ./packages/kafka/package.json
COPY packages/types/package.json      ./packages/types/package.json
COPY apps/workers/package.json        ./apps/workers/package.json

# Install all workspace dependencies (no dev deps for prod, but tsx is needed to run .ts directly)
RUN pnpm install --frozen-lockfile

# ── Stage 2: Copy source ──────────────────────────────────────────────────────
FROM node:22-slim AS runner

WORKDIR /app

# Install pnpm in runner stage too (needed for script execution)
RUN npm install -g pnpm@10.12.4

# Copy node_modules from deps stage
COPY --from=deps /app/node_modules        ./node_modules
COPY --from=deps /app/packages/db/node_modules      ./packages/db/node_modules
COPY --from=deps /app/packages/kafka/node_modules   ./packages/kafka/node_modules
COPY --from=deps /app/packages/types/node_modules   ./packages/types/node_modules
COPY --from=deps /app/apps/workers/node_modules     ./apps/workers/node_modules

# Copy workspace manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/db/package.json         ./packages/db/package.json
COPY packages/kafka/package.json      ./packages/kafka/package.json
COPY packages/types/package.json      ./packages/types/package.json
COPY apps/workers/package.json        ./apps/workers/package.json

# Copy source code for all workspace packages the worker depends on
COPY packages/db/       ./packages/db/
COPY packages/kafka/    ./packages/kafka/
COPY packages/types/    ./packages/types/
COPY apps/workers/      ./apps/workers/

ENV NODE_ENV=production

WORKDIR /app/apps/workers

# tsx is in node_modules/.bin so use pnpm exec
CMD ["pnpm", "exec", "tsx", "src/index.ts"]
