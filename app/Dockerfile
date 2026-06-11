# syntax=docker/dockerfile:1
# ── Stage 1: deps ──────────────────────────────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /build

# better-sqlite3 needs native build tools
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json* ./
# Cache mount keeps the npm download cache across builds, so a package.json
# change only downloads/compiles what's new instead of everything
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

# ── Stage 2: production image ──────────────────────────────────────────────
FROM node:20-alpine

WORKDIR /app

# Build-time git metadata (commit optional; time is stamped automatically)
ARG GIT_COMMIT=unknown

# Non-root user
RUN addgroup -S filetransfer && adduser -S -G filetransfer filetransfer

# Runtime deps only
COPY --from=deps /build/node_modules ./node_modules

# App source — only runtime files, in least-to-most-frequently-changed order
# so an edit to src/ or frontend/ doesn't bust earlier layers
COPY --chown=filetransfer:filetransfer package.json server.js ./
COPY --chown=filetransfer:filetransfer frontend ./frontend
COPY --chown=filetransfer:filetransfer src ./src

# Bake build info into a static JSON file served as a frontend asset.
# This layer sits after COPY, so any source change re-runs it with a fresh timestamp.
RUN echo "{\"commit\":\"${GIT_COMMIT}\",\"time\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" > frontend/version.json

# Persistent data dirs — mount these as volumes
RUN mkdir -p /data/storage /data/chunks /data/db /data/logs \
  && chown -R filetransfer:filetransfer /data

USER filetransfer

EXPOSE 3000

# Env defaults (override at runtime via --env-file or -e flags)
ENV NODE_ENV=production \
    PORT=3000 \
    STORAGE_PATH=/data/storage \
    CHUNKS_PATH=/data/chunks \
    DB_PATH=/data/db/filetransfer.db

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "server.js"]
