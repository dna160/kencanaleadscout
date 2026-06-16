# syntax=docker/dockerfile:1
# Multi-stage pnpm build (microPRD §8). Node 20, one Fastify service.
FROM node:20-slim AS base
RUN npm i -g pnpm@10
WORKDIR /app

# --- deps: install with a frozen lockfile against just the manifests ---
FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY apps/server/package.json apps/server/
RUN pnpm install --frozen-lockfile

# --- build: compile both packages ---
FROM deps AS build
COPY . .
RUN pnpm -r build

# --- run: production image ---
FROM base AS run
ENV NODE_ENV=production
COPY --from=build /app ./
EXPOSE 8080
CMD ["node", "apps/server/dist/index.js"]
