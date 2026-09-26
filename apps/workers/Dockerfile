# ── Stage 1: Dependencies ────────────────────────────────────────────────────
FROM node:26-slim AS deps

WORKDIR /app

RUN npm install -g pnpm@10.12.4

# Workspace manifests needed for pnpm to resolve the worker's dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/config/package.json         ./packages/config/package.json
COPY packages/db/package.json             ./packages/db/package.json
COPY packages/kafka/package.json          ./packages/kafka/package.json
COPY packages/review-engine/package.json  ./packages/review-engine/package.json
COPY packages/types/package.json          ./packages/types/package.json
COPY apps/workers/package.json            ./apps/workers/package.json

# Only the workers and the packages they use (tsx runs the TypeScript directly)
RUN pnpm install --frozen-lockfile --filter workers...

# ── Stage 2: Runtime ─────────────────────────────────────────────────────────
FROM node:26-slim AS runner

WORKDIR /app

# node_modules (pnpm symlinks into /app/node_modules/.pnpm, so copy the lot)
COPY --from=deps /app /app

# Source for the worker and every workspace package it imports
COPY packages/config/        ./packages/config/
COPY packages/db/            ./packages/db/
COPY packages/kafka/         ./packages/kafka/
COPY packages/review-engine/ ./packages/review-engine/
COPY packages/types/         ./packages/types/
COPY apps/workers/           ./apps/workers/

ENV NODE_ENV=production

# Run as the unprivileged "node" user that ships with the base image
USER node

WORKDIR /app/apps/workers

CMD ["node_modules/.bin/tsx", "src/index.ts"]
