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

Server binds to `127.0.0.1` only — expose via Cloudflare Tunnel.

---

## Architecture

```
[Browser]
    │ HTTPS / WSS
    ▼
[Cloudflare DNS + WAF + DDoS]
    │
[Cloudflare Tunnel → cloudflared]
    │
[Fastify — 127.0.0.1 only]
  ├── Auth (WebAuthn + TOTP + JWT)
  ├── File API (upload / download / manage)
  ├── WebSocket (real-time progress)
  └── Middleware: rate-limit → CSRF → JWT → CSP → file-type → path-sanitize

[SQLite]           [Encrypted storage]
  credentials        AES-256-GCM blobs
  sessions           UUID filenames only
  file metadata      chunks/ (temp, auto-wiped)
  transfer history
```

---

## Authentication

**Primary — Passkey (WebAuthn / FIDO2)**
- Fingerprint, FaceID, Windows Hello
- Phishing-resistant, domain-bound
- Library: `@simplewebauthn/server`

**Fallback — TOTP**
- Google Authenticator / Authy
- 6-digit, rate-limited (5 attempts / 10 min)
- Backup codes: PBKDF2-hashed, one-time use

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
POST /api/upload/simple            # < 10 MB
POST /api/upload/init              # chunked: get uploadId
PUT  /api/upload/chunk/:id/:index  # send one chunk
POST /api/upload/finalize/:id      # assemble + verify + encrypt
POST /api/upload/abort/:id         # cleanup
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
    routes/               auth.js, files.js, upload.js, health.js, history.js
    services/             encryption.js, file.js, auth.js, zip.js, watcher.js
    middleware/           jwt.js, csrf.js, fileType.js, pathSanitize.js
    db/                   schema.sql, migrate.js, db.js
    ws/                   server.js, handlers.js
  frontend/
    index.html
    css/                  main.css, animations.css, components.css
    js/                   app.js, auth.js, upload.js, websocket.js,
                          fileManager.js, progress.js, qr.js,
                          history.js, notifications.js, utils.js
  package.json
  .env.example
```

---

## VPS Deployment

### Directory layout

```
/opt/filetransfer/
  app/          → clone repo here
  storage/      → AES-256 blobs (UUID names)
  chunks/       → temp, wiped post-finalize
  db/
    filetransfer.db
  logs/
  .env          → root:root, mode 600, NOT in repo
```

### systemd service

```ini
[Unit]
Description=Groovy YAO File Transfer
After=network.target

[Service]
Type=simple
User=filetransfer
Group=filetransfer
WorkingDirectory=/opt/filetransfer/app
EnvironmentFile=/opt/filetransfer/.env
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/opt/filetransfer/storage /opt/filetransfer/db /opt/filetransfer/logs

[Install]
WantedBy=multi-user.target
```

### Cloudflare setup

1. Install `cloudflared` on VPS
2. Run `cloudflared tunnel create filetransfer`
3. Point DNS CNAME to tunnel
4. Set TLS mode to **Full (Strict)**
5. Enable WAF OWASP Core Ruleset
6. Set Cloudflare edge rate limit: 1000 req/min

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
- [x] Node binds `127.0.0.1` only
- [ ] Validate `CF-Connecting-IP` from Cloudflare ASN only
- [ ] systemd non-root user + `NoNewPrivileges`
- [ ] `.env` mode 600, root:root
- [ ] `npm audit` clean before deploy
- [ ] Daily SQLite backup

---

## Implementation Phases

| Phase | Scope | Status |
|-------|-------|--------|
| 1 | Foundation — Fastify, DB, encryption, health, frontend shell | ✅ Done |
| 2 | Authentication — WebAuthn + TOTP + JWT sessions | 🔲 |
| 3 | Core file ops — upload, download, list, delete, expiry | 🔲 |
| 4 | Chunked upload + resume (5 MB chunks, SHA-256) | 🔲 |
| 5 | Real-time — WebSocket progress, cross-device push | 🔲 |
| 6 | Enhanced — QR, clipboard paste, ZIP, history, stats | 🔲 |
| 7 | Hardening + VPS deployment | 🔲 |

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
