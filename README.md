# Groovy YAO — Personal Secure File Transfer

Self-hosted, single-user file transfer system. Runs on a VPS behind Cloudflare Tunnel. No open inbound ports. Cyberpunk UI.

---

## Stack

| Layer | Tech |
|-------|------|
| Runtime | Node.js 20 LTS |
| HTTP | Fastify 4 |
| WebSocket | @fastify/websocket |
| Database | SQLite (better-sqlite3) |
| Auth | WebAuthn (passkey) + TOTP |
| Encryption | AES-256-GCM, HKDF key derivation |
| Frontend | Vanilla JS + custom CSS |

---

## Quick Start

### 1. Install dependencies

```bash
cd app
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` — generate secrets with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"  # 32-byte → 64 hex chars
node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"  # 16-byte → 32 hex chars
```

| Variable | Format | Purpose |
|----------|--------|---------|
| `MASTER_SECRET` | 64 hex chars | HKDF root for file encryption |
| `JWT_SECRET` | 64 hex chars | JWT signing |
| `CSRF_SECRET` | 32 hex chars | CSRF double-submit cookie |
| `IP_HMAC_KEY` | 32 hex chars | Audit log IP hashing |
| `DOMAIN` | `https://yourdomain.com` | Used in CSP + WebAuthn origin |
| `STORAGE_PATH` | absolute path | Encrypted file blobs |
| `CHUNKS_PATH` | absolute path | Temp chunk storage |
| `DB_PATH` | absolute path | SQLite database file |
| `PORT` | integer | Default `3000` |
| `MAX_FILE_SIZE_MB` | integer | Default `5120` (5 GB) |

### 3. Run

```bash
# Development
npm run dev

# Production
npm start
```

Server binds to `0.0.0.0` inside Docker — exposed to host via port mapping, proxied by Nginx.

---

## Architecture

```
[Browser]
    │ HTTPS / WSS
    ▼
[Cloudflare DNS + WAF + DDoS]
    │
[Nginx reverse proxy — subdomain]
    │ proxy_pass 127.0.0.1:3002
    ▼
[Docker container — port 3002:3000]
  [Fastify — 0.0.0.0:3000]
    ├── Auth (WebAuthn + TOTP + JWT)
    ├── File API (upload / download / manage)
    ├── WebSocket /ws (JWT auth on Upgrade)
    └── Middleware: rate-limit → CSRF → JWT → CSP → file-type → path-sanitize

[SQLite]           [Encrypted storage]       [Docker volumes]
  credentials        AES-256-GCM blobs         filetransfer_storage
  sessions           UUID filenames only        filetransfer_chunks
  file metadata      chunks/ (temp, auto-wiped) filetransfer_db
  transfer history
```

---

## Authentication

**Primary — Passkey (WebAuthn / FIDO2)**
- Fingerprint, FaceID, Windows Hello
- Phishing-resistant, domain-bound
- Library: `@simplewebauthn/server`

**Fallback — Password & TOTP**
- Standalone Password login or Password + TOTP Combination
- Rate-limited (5 attempts / 10 min) and protected by `bcrypt` hashes (12 rounds)
- Full Auto-Login capabilities using rotation-bound Device Tokens
- TOTP Backup codes: SHA-256 hashed, one-time use

**Sessions**
- Access token: JWT, 15-min expiry, `httpOnly` cookie
- Refresh token: 7-day, hashed in DB, rotated on use
- Flags: `httpOnly`, `Secure`, `SameSite=Strict`

---

## Encryption

```
Master key  = HKDF(SHA-256, MASTER_SECRET, salt="filetransfer-v1", info="file-encryption")
Per-file key = HKDF(master key, random_16B_salt, info=file_uuid)
Cipher      = AES-256-GCM, random 12-byte IV, 16-byte GCM tag

Stream format on disk: [12-byte IV][ciphertext][16-byte GCM tag]
```

- Original filenames encrypted (AES-256-GCM), stored in DB only
- TOTP secret encrypted with same scheme
- Plaintext never touches disk

---

## Security Architecture (Hardened)

The application perimeter and internal engines have been independently audited for production deployment:

- **HTTPS Constraint Hooks**: Fastify inherently intercepts and demands `https://` proxy evaluations (`x-forwarded-proto`), forcefully re-routing outbound unencrypted frames globally in production boundaries.
- **SQLite Encapsulation**: The persistence engine statically accesses independent runtime storage, entirely blocked from `/frontend/` structures to omit standard database web crawler indexing natively.
- **XSS & DOM Hardening**: Direct assignments into the Document Object Model UI are strongly protected via mathematical `Utils.escape()` overrides completely rendering tags, quotes, and bounds into benign encoded equivalents prior to hydration.
- **Memory Defensive Streams**: AES-256-GCM logic strictly utilizes 16-byte rolling window streams to authenticate gigabyte payload headers. It functionally eliminates OOM (Out Of Memory) Denial of Service attacks when parsing multithreaded downloads.
- **Rate Limit & Internal Telemetry**: Utilizing `Pino`, specific backend authentication hooks broadcast distinct log outputs capturing explicitly flagged `AUTH_SUCCESS` / `AUTH_FAILURE` metrics and intercepting API DDOS abuse patterns dynamically under customized `TRAFFIC_ANOMALY` logs. Unhandled inner bugs squelch securely into an anonymous `500 - Internal Server Error` protecting structural database stack traces.

---

## API Reference

### Auth
```
POST /api/auth/webauthn/register/begin
POST /api/auth/webauthn/register/complete
POST /api/auth/webauthn/authenticate/begin
POST /api/auth/webauthn/authenticate/complete
POST /api/auth/totp/setup
POST /api/auth/totp/verify
POST /api/auth/logout
GET  /api/auth/session
```

### Upload
```
POST /api/upload/simple                          # < 10 MB, sync
POST /api/upload/chunked/init                    # begin chunked upload, returns uploadId + receivedChunks
PUT  /api/upload/chunked/:uploadId/chunk/:index  # upload one chunk (idempotent, SHA-256 verified)
POST /api/upload/chunked/:uploadId/finalize      # assemble chunks, verify file SHA-256, encrypt to disk
DELETE /api/upload/chunked/:uploadId             # abort + cleanup chunks
GET  /api/upload/chunked/:uploadId/status        # resume: get received chunk indices
```

### Files
```
GET    /api/files
GET    /api/files/:id
GET    /api/files/:id/download
GET    /api/files/:id/qr
PATCH  /api/files/:id/expiry
DELETE /api/files/:id
POST   /api/files/zip
```

### WebSocket
```
GET    /ws                               # JWT auth via access_token cookie
```

Events broadcast to all connected clients:
- `UPLOAD_PROGRESS` — `{ uploadId, percent, bytesLoaded, totalSize }`
- `UPLOAD_COMPLETE` — `{ uploadId, fileId, filename, size, downloadUrl }`

### Other
```
GET    /api/history
DELETE /api/history
GET    /api/stats
GET    /api/health          # no auth — Cloudflare health check
```

---

## Project Structure

```
app/
  server.js               entry point
  src/
    config.js             env validation + config accessors
    app.js                Fastify instance + plugin registration
    routes/               auth.js, files.js, chunks.js, health.js, ws.js
    middleware/           jwt.js, fileType.js
    services/             encryption.js, auth.js, expiry.js
    db/                   migrate.js, db.js
  frontend/
    index.html
    css/                  main.css, animations.css, components.css
    js/                   app.js, auth.js, upload.js, websocket.js,
                          fileManager.js, progress.js, qr.js,
                          history.js, stats.js, notifications.js, utils.js
  package.json
  .env.example
```

---

## Chunked Upload

Files ≥ 10 MB use chunked upload with resume support.

```
1. POST /api/upload/chunked/init       → uploadId, receivedChunks[]
2. PUT  /api/upload/chunked/:id/chunk/:i  (repeat per chunk, idempotent)
3. POST /api/upload/chunked/:id/finalize  → fileId, downloadUrl
```

- Chunk size: 5 MB
- Per-chunk SHA-256 verified server-side (`x-chunk-sha256` header)
- Full-file SHA-256 verified on finalize
- Resume: init returns already-received indices; client skips them
- `window.online` event triggers auto-resume of interrupted uploads
- SHA-256 computed off-main-thread via `hashWorker.js` (Web Worker)
- 3-retry exponential backoff per chunk

---

## VPS Deployment (Docker + Nginx)

### Prerequisites

- Docker + Docker Compose installed on VPS
- Nginx installed (`apt install nginx`)
- Certbot installed (`apt install certbot python3-certbot-nginx`)
- Domain A record pointing to VPS IP

### 1. Clone repo

```bash
cd /opt
mkdir filetransfer && cd filetransfer
git clone https://github.com/YOUR_USER/YOUR_REPO.git app
```

### 2. Configure .env

```bash
cp app/app/.env.example app/app/.env
nano app/app/.env
```

```env
PORT=3000
DOMAIN=https://files.yourdomain.com      # must include https://
NODE_ENV=production
MASTER_SECRET=<64 hex chars>
JWT_SECRET=<64 hex chars>
CSRF_SECRET=<32 hex chars>
IP_HMAC_KEY=<32 hex chars>
STORAGE_PATH=/data/storage               # absolute path — must start with /
CHUNKS_PATH=/data/chunks                 # absolute path — must start with /
DB_PATH=/data/db/filetransfer.db         # absolute path — must start with /
MAX_FILE_SIZE_MB=5120
```

Generate secrets:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"  # → 64 hex (MASTER_SECRET, JWT_SECRET)
node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"  # → 32 hex (CSRF_SECRET, IP_HMAC_KEY)
```

> **Gotchas:**
> - `DOMAIN` must be `https://yourdomain.com` — WebAuthn will fail without the protocol prefix
> - `STORAGE_PATH`, `CHUNKS_PATH`, `DB_PATH` must be absolute paths starting with `/` — relative paths cause permission errors inside Docker

### 3. Start Docker

```bash
cd /opt/filetransfer/app
docker compose up -d --build
docker compose logs -f
```

Data is persisted in named Docker volumes: `filetransfer_storage`, `filetransfer_chunks`, `filetransfer_db`, `filetransfer_logs`.

### 4. Nginx config

```bash
nano /etc/nginx/sites-available/filetransfer
```

```nginx
server {
    listen 80;
    server_name files.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:3002;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600;
        proxy_send_timeout 3600;
        client_max_body_size 5120m;
    }
}
```

```bash
ln -s /etc/nginx/sites-available/filetransfer /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

### 5. SSL

```bash
certbot --nginx -d files.yourdomain.com
```

> DNS A record must exist and propagate before Certbot will succeed. Verify with `nslookup files.yourdomain.com`.

### 6. Update on new release

```bash
cd /opt/filetransfer/app
git pull
docker compose down
docker compose up -d --build
```

---

## Security Checklist

- [x] AES-256-GCM encryption at rest, per-file random IV
- [x] HKDF key derivation — raw master secret never used directly
- [x] UUID-only filenames on disk
- [x] Magic-byte MIME validation (`file-type`)
- [x] Executable type blocking (exe, sh, dll, bat, ps1…)
- [x] CSRF double-submit cookie
- [x] Rate limiting (100 req/min general, 10 req/min auth)
- [x] Strict CSP headers
- [x] HSTS via Cloudflare + Helmet
- [x] `httpOnly` + `Secure` + `SameSite=Strict` cookies
- [x] Path traversal prevention (UUID params + `path.resolve` check)
- [x] Node binds `0.0.0.0` inside Docker, port-mapped to `127.0.0.1:3002` on host
- [x] `cf-connecting-ip` used as rate-limit key generator
- [x] Docker non-root user (`filetransfer`) + read-only app layer
- [x] `.env` mode 600, root:root
- [x] `npm audit` clean before deploy
- [x] Daily SQLite backup

---

## Implementation Phases

| Phase | Scope | Status |
|-------|-------|--------|
| 1 | Foundation — Fastify, DB, encryption, health, frontend shell | ✅ Done |
| 2 | Authentication — WebAuthn + TOTP + JWT sessions | ✅ Done |
| 3 | Core file ops — upload, download, list, delete, expiry | ✅ Done |
| 4 | Chunked upload + resume (5 MB chunks, SHA-256) | ✅ Done |
| 5 | Real-time — WebSocket progress, cross-device push | ✅ Done |
| 6 | Enhanced — QR, clipboard paste, ZIP, history, stats | ✅ Done |
| 7 | Hardening + VPS deployment | ✅ Done |

---

## Development

```bash
# Run tests
npm test

# E2E tests
npm run test:e2e

# Build frontend bundle
npm run build
```

Tests use **Vitest** (unit) and **Playwright** (E2E).
