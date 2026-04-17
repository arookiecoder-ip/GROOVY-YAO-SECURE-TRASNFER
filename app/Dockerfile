# ── Stage 1: deps ──────────────────────────────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /build

# better-sqlite3 needs native build tools
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# ── Stage 2: production image ──────────────────────────────────────────────
FROM node:20-alpine

WORKDIR /app

# Non-root user
RUN addgroup -S filetransfer && adduser -S -G filetransfer filetransfer

# Runtime deps only
COPY --from=deps /build/node_modules ./node_modules

# App source
COPY --chown=filetransfer:filetransfer . .

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
