# GROOVY YAO — Personal Secure Real-Time File Transfer System

## Context

Single-user, self-hosted file transfer app for personal use only. Hosted on a VPS behind Cloudflare Tunnel with a custom domain. No public access, no multi-user — security is built around the assumption that any request bypassing auth is hostile. The name "Groovy YAO" is a placeholder; rename at will.

---

## System Architecture

```
[Browser: Any Device]
       │ HTTPS / WSS
       ▼
[Cloudflare DNS + WAF + DDoS Protection]
       │
[Cloudflare Tunnel → cloudflared daemon on VPS]
       │ (no open inbound ports on VPS — outbound tunnel only)
       ▼
[Node.js / Fastify — 127.0.0.1 only]
   ├── Auth Module (WebAuthn + TOTP + JWT)
   ├── File API (upload / download / manage)
   ├── WebSocket Server (real-time progress, cross-device push)
   └── Middleware Stack
         Rate Limiter → CSRF Guard → JWT Verify → CSP Headers
         → File Type Validator → Path Sanitizer → Request Logger

[SQLite via better-sqlite3]        [Encrypted File Storage]
  - credentials, sessions           /var/filetransfer/storage/
  - file metadata                   - AES-256-GCM blobs
  - transfer history                - UUID filenames only
  - upload chunks state             - chunks/ temp dir (auto-wiped)
```

---

## Authentication Strategy

**Primary: Passkey (WebAuthn / FIDO2)**
- Works via fingerprint (Android/iOS), FaceID, or Windows Hello
- Phishing-resistant — credential is domain-bound
- Library: `@simplewebauthn/server`
- Replay protection: signature counter stored in DB

**Fallback: TOTP (Google Authenticator / Authy)**
- 6-digit time-based OTP
- Library: `otplib`
- Rate-limited: 5 attempts per 10 min
- Backup codes: PBKDF2-hashed, one-time use

**Session management:**
- Access token: JWT, 15-min expiry, `httpOnly` cookie
- Refresh token: 7-day, hashed in DB, rotated on use
- Cookie flags: `httpOnly`, `Secure`, `SameSite=Strict`

---

## Core Features

### File Transfer
- [ ] Drag-and-drop upload (full-page drop zone)
- [ ] Clipboard paste (images and files via `paste` event)
- [ ] Chunked upload with resume (5MB chunks, SHA-256 per chunk)
- [ ] SHA-256 full-file integrity verification on finalize
- [ ] Simple upload path for files < 10MB
- [ ] Multi-file + folder upload → auto-ZIP
- [ ] File expiry: 1h / 24h / 7d / permanent (configurable per file)
- [ ] Auto-delete expired files (cron every 5 min)

### Download / Sharing
- [ ] Instant download link after upload
- [ ] QR code overlay for mobile download (one-click)
- [ ] Download URL auto-copied to clipboard on upload complete
- [ ] Extend expiry action
- [ ] Download counter tracked

### Real-Time
- [ ] WebSocket progress bar (per-chunk updates)
- [ ] Live transfer speed (MB/s, rolling 2s window)
- [ ] ETA countdown
- [ ] Cross-device push: upload on laptop → phone gets WS notification
- [ ] Auto-reconnect WebSocket (exponential backoff)

### File Manager
- [ ] List view (terminal-style `ls -la` aesthetic)
- [ ] Grid view (card tiles)
- [ ] Toggle persists across reload
- [ ] Sort by: date, size, name
- [ ] Expiry countdown (live, turns yellow <1hr, red <10min)
- [ ] Transfer history log (upload / download / delete / expire events)
- [ ] History export as JSON

### Security
- [ ] AES-256-GCM encryption at rest (per-file random IV + GCM tag)
- [ ] HKDF key derivation from master env secret (never raw key)
- [ ] UUID filenames on disk (original name only in encrypted DB field)
- [ ] Server-side MIME type validation via magic bytes (`file-type` lib)
- [ ] Block executable types (exe, sh, dll, etc.)
- [ ] CSRF protection (double-submit cookie)
- [ ] Rate limiting (100 req/min general, 10 req/min auth)
- [ ] Strict CSP headers
- [ ] HSTS via Cloudflare + Helmet
- [ ] Path traversal prevention (UUID-only filenames, `path.resolve` check)
- [ ] Cloudflare origin validation (reject requests not from Cloudflare ASN)

---

## Tech Stack

| Layer | Choice | Reason |
|-------|--------|--------|
| Runtime | Node.js 20 LTS | Stable, stream support for large files |
| HTTP Framework | Fastify | Faster than Express, schema validation built-in |
| WebSocket | `@fastify/websocket` (ws) | Native, no overhead |
| Database | SQLite via `better-sqlite3` | Zero ops, sync API, perfect for single user |
| Auth | `@simplewebauthn/server` + `otplib` | Battle-tested, spec-compliant |
| JWT | `jose` | Modern, audited JOSE library |
| File handling | `@fastify/multipart` (busboy) | Streaming, memory-safe |
| Encryption | Node.js built-in `crypto` | No extra dependency, battle-tested |
| MIME detection | `file-type` | Magic bytes, not extension |
| ZIP | `archiver` | Streaming ZIP, handles large files |
| QR | `qrcode` (server-side) | No client-side library needed |
| Cron | `node-cron` | File expiry watcher |
| Security middleware | `@fastify/helmet`, `@fastify/rate-limit` | Standard |
| Frontend | Vanilla JS + custom CSS | No framework overhead, full CSS control for cyberpunk theme |
| Build | esbuild | Minimal, fast |
| Testing | Vitest + Playwright | Unit + E2E |

---

## API Endpoints

### Auth
```
POST /api/auth/webauthn/register/begin
POST /api/auth/webauthn/register/complete
POST /api/auth/webauthn/authenticate/begin
POST /api/auth/webauthn/authenticate/complete
POST /api/auth/totp/setup          [first-run only]
POST /api/auth/totp/verify
POST /api/auth/logout
GET  /api/auth/session
```

### Upload
```
POST /api/upload/simple            [< 10MB, direct]
POST /api/upload/init              [chunked: declare upload, get uploadId]
PUT  /api/upload/chunk/:id/:index  [send one chunk]
POST /api/upload/finalize/:id      [assemble + verify + encrypt]
POST /api/upload/abort/:id         [cleanup chunks]
```

### Files
```
GET    /api/files                  [list with sort/filter/page]
GET    /api/files/:id              [metadata]
GET    /api/files/:id/download     [stream decrypted file]
GET    /api/files/:id/qr           [QR code data URL]
PATCH  /api/files/:id/expiry       [extend expiry]
DELETE /api/files/:id
POST   /api/files/zip              [multi-file ZIP download]
```

### Other
```
GET /api/history                   [transfer log]
DELETE /api/history
GET /api/stats                     [storage used, file count]
GET /api/health                    [no auth — Cloudflare health check]
```

### WebSocket Events
```
Client → Server:
  AUTH { token }
  SUBSCRIBE_UPLOAD { uploadId }
  PING

Server → Client:
  UPLOAD_PROGRESS { uploadId, percent, speed, eta }
  UPLOAD_COMPLETE { uploadId, fileId, downloadUrl }
  DOWNLOAD_READY  { fileId, filename, size }
  FILE_EXPIRED    { fileId }
  PONG
```

---

## Database Schema

```sql
-- WebAuthn credentials
CREATE TABLE webauthn_credentials (
    id TEXT PRIMARY KEY,            -- credential ID (base64url)
    public_key BLOB NOT NULL,
    counter INTEGER NOT NULL DEFAULT 0,
    device_type TEXT,
    transports TEXT,                -- JSON array
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
);

-- TOTP (enforced single row)
CREATE TABLE totp_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    secret TEXT NOT NULL,           -- encrypted
    enabled INTEGER DEFAULT 0,
    backup_codes TEXT,              -- JSON array of PBKDF2 hashes
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
);

-- WebAuthn challenge cache (5min TTL)
CREATE TABLE auth_challenges (
    id TEXT PRIMARY KEY,
    challenge TEXT NOT NULL,
    type TEXT NOT NULL,             -- 'registration' | 'authentication'
    expires_at INTEGER NOT NULL,
    used INTEGER DEFAULT 0
);

-- Sessions / refresh tokens
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    refresh_token TEXT NOT NULL UNIQUE, -- hashed
    auth_method TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_seen_at INTEGER,
    ip_hash TEXT,
    revoked INTEGER DEFAULT 0
);

-- Files
CREATE TABLE files (
    id TEXT PRIMARY KEY,            -- UUID (in URLs)
    storage_id TEXT NOT NULL UNIQUE, -- UUID (on-disk filename)
    original_name TEXT NOT NULL,    -- AES-256-GCM encrypted, base64
    original_name_iv TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,           -- hex, plaintext hash
    encryption_iv TEXT NOT NULL,    -- base64
    encryption_tag TEXT NOT NULL,   -- GCM auth tag, base64
    expires_at INTEGER,             -- NULL = permanent
    created_at INTEGER NOT NULL,
    download_count INTEGER DEFAULT 0,
    status TEXT DEFAULT 'complete'  -- 'uploading'|'complete'|'expired'|'deleted'
);
CREATE INDEX idx_files_expires_at ON files(expires_at) WHERE expires_at IS NOT NULL;

-- Chunked upload sessions
CREATE TABLE uploads (
    id TEXT PRIMARY KEY,
    original_name TEXT NOT NULL,    -- encrypted
    original_name_iv TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    total_size INTEGER NOT NULL,
    total_chunks INTEGER NOT NULL,
    sha256_expected TEXT NOT NULL,
    expires_in TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    status TEXT DEFAULT 'in_progress'
);

CREATE TABLE upload_chunks (
    upload_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    size_bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    PRIMARY KEY (upload_id, chunk_index),
    FOREIGN KEY (upload_id) REFERENCES uploads(id) ON DELETE CASCADE
);

-- Audit log
CREATE TABLE transfer_history (
    id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,       -- 'upload'|'download'|'delete'|'expire'|'auth'
    file_id TEXT,
    size_bytes INTEGER,
    duration_ms INTEGER,
    ip_hash TEXT,
    timestamp INTEGER NOT NULL,
    metadata TEXT                   -- JSON blob
);
CREATE INDEX idx_history_timestamp ON transfer_history(timestamp DESC);

-- App config (KV)
CREATE TABLE app_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
```

---

## Encryption Design

```
Master key = HKDF(SHA-256, MASTER_SECRET_env, salt="filetransfer-v1", info="file-encryption")
Per-file key = HKDF(master key, random_16_byte_salt, info=file_uuid)
Cipher = AES-256-GCM
IV = random 12 bytes (stored in DB)
GCM tag = 16 bytes (stored in DB)
Original filename = same scheme, stored in files.original_name
TOTP secret = same scheme, stored in totp_config.secret
```

Files are encrypted as a **streaming pipeline**:
`ReadStream → AES-256-GCM encrypt transform → WriteStream (disk UUID)`

Downloads are decrypted the same way in reverse — plaintext never touches disk.

---

## Frontend: Cyberpunk Design System

```css
--color-bg:       #0a0a0f   /* near-black */
--color-surface:  #0f0f1a
--color-border:   #1a1a2e
--color-cyan:     #00f5ff   /* upload, success, primary action */
--color-magenta:  #ff00ff   /* downloads, alerts */
--color-purple:   #9d00ff   /* history, info */
--color-yellow:   #ffee00   /* warnings, expiry soon */
--color-red:      #ff003c   /* errors, delete */
--font-mono:      'JetBrains Mono', 'Fira Code', monospace
```

**Key animations:**
- Boot sequence: matrix-rain text resolves into logo on auth screen
- Neon border pulse on drag-hover
- Segmented progress bar fills with scanline texture + cyan glow
- Glitch flash on upload complete ("TRANSFER COMPLETE")
- Expiry countdown turns yellow → red as time runs out
- Toast notifications: scan-line bg, neon border, glitch-in entrance

**Frontend file structure:**
```
frontend/
  css/
    main.css          — tokens, reset, layout
    animations.css    — glitch, scanlines, neon-pulse, flicker keyframes
    components.css    — component styles
  js/
    app.js            — entry, router, boot init
    auth.js           — WebAuthn + TOTP UI + API calls
    upload.js         — UploadManager: chunking, retry, resume
    hashWorker.js     — Web Worker: SHA-256 (non-blocking)
    websocket.js      — singleton WS client with reconnect
    fileManager.js    — file list/grid, sort, filter
    progress.js       — CyberpunkProgressBar + SpeedOMeter
    qr.js             — QR overlay
    history.js        — transfer history view
    notifications.js  — toast system
    utils.js          — formatBytes, formatDuration, debounce
  index.html
```

---

## Security Hardening Checklist

### Network
- [ ] Cloudflare Full (Strict) TLS mode
- [ ] WAF: OWASP Core Ruleset enabled
- [ ] Rate limiting at Cloudflare edge (1000 req/min before VPS)
- [ ] Node binds to `127.0.0.1` only — cloudflared is sole entry
- [ ] Validate `CF-Connecting-IP` only from Cloudflare ASN

### HTTP Middleware (ordered)
1. IP extraction (CF-Connecting-IP)
2. Rate limiter (100/min general, 10/min auth)
3. Helmet (HSTS, X-Frame-Options: DENY, X-Content-Type-Options)
4. CSP: `default-src 'self'; script-src 'self'; img-src 'self' data: blob:; connect-src 'self' wss://yourdomain.com; frame-ancestors 'none'`
5. CSRF double-submit cookie
6. JWT verification (httpOnly cookie)
7. Body size limits (100MB upload endpoints, 1MB elsewhere)
8. Path sanitizer (UUID-only params, no `../`)

### File Security
- [ ] Magic-byte MIME validation via `file-type` (not just extension)
- [ ] Block: exe, sh, bat, dll, msi, ps1, py, php, etc.
- [ ] On-disk filenames = UUID only (original name encrypted in DB)
- [ ] All constructed paths verified to stay within storage root
- [ ] Temp chunks auto-wiped: post-finalize + cron cleanup (>24hr stale)
- [ ] No plaintext file content in logs

### Operational
- [ ] systemd service as non-root `filetransfer` user
- [ ] `NoNewPrivileges=true`, `ProtectSystem=strict`, `PrivateTmp=true`
- [ ] `.env` owned root:root, mode 600, not in repo
- [ ] Daily SQLite backup: `sqlite3 filetransfer.db .dump > backup`
- [ ] `npm audit` clean before each deploy
- [ ] Log rotation (no sensitive data in logs)

---

## Implementation Phases

### Phase 1 — Foundation (Days 1–3)
- [ ] Init Node.js project, Fastify, TypeScript config
- [ ] SQLite migration script, create all tables
- [ ] Fastify plugins: Helmet, rate-limit, cookie, multipart, static, websocket
- [ ] `EncryptionService` — HKDF key derivation, AES-256-GCM stream encrypt/decrypt
- [ ] Env var validation on startup (crash-fast if secrets missing)
- [ ] Health endpoint
- [ ] Frontend: HTML shell, CSS design system tokens, boot animation

**Milestone:** App boots, renders auth screen, all security headers pass securityheaders.com audit

---

### Phase 2 — Authentication (Days 4–6)
- [ ] First-run detection (no credentials → setup wizard)
- [ ] WebAuthn registration flow (begin + complete endpoints)
- [ ] WebAuthn authentication flow (begin + complete endpoints)
- [ ] TOTP setup (secret gen, QR provision, confirm-first-code)
- [ ] TOTP verification endpoint
- [ ] JWT issuance + refresh token rotation + logout
- [ ] Auth middleware protecting all `/api/*` except auth endpoints
- [ ] Frontend: boot animation → auth screen, passkey button, TOTP fallback input

**Milestone:** Register passkey on desktop, authenticate via fingerprint on phone

---

### Phase 3 — Core File Operations (Days 7–12)
- [ ] Simple upload endpoint (< 10MB, sync, encrypts to disk)
- [ ] Download endpoint (decrypt stream, correct Content-Disposition)
- [ ] File listing endpoint (sort/filter/page)
- [ ] File delete endpoint (disk + DB cleanup)
- [ ] Expiry watcher cron
- [ ] Frontend: DropZone drag-and-drop, file queue, simple upload
- [ ] Frontend: FileManager list view
- [ ] Frontend: Download + delete actions

**Milestone:** Upload → download → auto-expire full cycle working

---

### Phase 4 — Chunked Upload + Resume (Days 13–16)
- [ ] Upload init + per-chunk endpoint + finalize + abort
- [ ] Chunk assembly with SHA-256 verification
- [ ] Resume: init returns already-received chunk indices; client skips them
- [ ] SHA-256 Web Worker in frontend (hashWorker.js)
- [ ] Frontend: UploadManager chunking logic (5MB chunks, 3-retry backoff)
- [ ] Frontend: resume on reconnect

**Milestone:** 2GB upload survives browser reload mid-transfer

---

### Phase 5 — Real-Time (Days 17–19)
- [ ] WebSocket server (JWT auth on Upgrade request)
- [ ] Server emits UPLOAD_PROGRESS per chunk
- [ ] Server emits UPLOAD_COMPLETE / DOWNLOAD_READY
- [ ] Frontend: WebSocketClient singleton + reconnect
- [ ] Frontend: CyberpunkProgressBar (WS-driven, segmented, neon glow)
- [ ] Frontend: SpeedOMeter (circular gauge aesthetic)
- [ ] Frontend: Toast notifications for WS events
- [ ] Cross-device push (upload on laptop → phone gets WS notification)

**Milestone:** Animated progress bar live, phone notified when file ready

---

### Phase 6 — Enhanced Features (Days 20–24)
- [ ] QR code generation endpoint + frontend overlay
- [ ] Clipboard paste handler (images + files)
- [ ] Multi-file + folder upload → ZIP streaming
- [ ] Transfer history endpoint + history view (terminal log style)
- [ ] Extend expiry action
- [ ] Grid view toggle in FileManager
- [ ] Stats endpoint + dashboard widget

**Milestone:** All 13 core features implemented

---

### Phase 7 — Hardening + Deployment (Days 25–28)
- [ ] Full security checklist audit
- [ ] `file-type` MIME validation integrated
- [ ] `npm audit` — 0 high/critical
- [ ] cloudflared tunnel setup + DNS config
- [ ] systemd service file (non-root user, resource limits)
- [ ] .env setup (not in repo, mode 600)
- [ ] Log rotation config
- [ ] Daily SQLite backup script
- [ ] First-run wizard test on clean machine
- [ ] Load test: 2GB file upload with `autocannon`

**Milestone:** Live on VPS, accessible via custom domain, tested from phone + desktop

---

## Key Files (Critical Implementation Order)

1. `src/db/schema.sql` + `src/db/migrate.js` — prerequisite for everything
2. `src/services/encryption.js` — HKDF + AES-256-GCM; must be correct before file ops
3. `src/middleware/jwt.js` — gates all authenticated routes; must be airtight before file endpoints
4. `src/routes/upload.js` — most complex backend file (init/chunk/finalize/abort + assembly)
5. `frontend/js/upload.js` — most complex frontend file (chunking + hash worker + resume)
6. `src/ws/server.js` — WebSocket with JWT auth on upgrade
7. `frontend/css/animations.css` — cyberpunk visual identity

---

## Testing Strategy

### Unit (Vitest)
- EncryptionService: round-trip, different IVs, tampered ciphertext fails
- FileService: blocked MIME types, path traversal rejection, SHA-256 mismatch
- AuthService: challenge TTL, counter replay, TOTP rate limit, backup codes
- ChunkManager: out-of-order chunks, missing chunk on finalize, assembly hash

### Integration (supertest + Fastify)
- Unauthenticated → 401 on all /api/* except auth/health
- Full WebAuthn flow → session valid → logout → 401
- CSRF missing → 403
- Simple upload → download → bytes identical
- Chunked upload (5 chunks) → finalize → download = original
- Wrong SHA-256 on finalize → rejected
- Download after expiry → 404
- Rate limit: 11th auth attempt in 60s → 429
- Path traversal in file ID → 400
- .exe upload → 415
- All responses have correct security headers

### E2E (Playwright)
- First-run setup wizard: register passkey + TOTP
- Auth via passkey → land on file manager
- Drag-and-drop → progress bar animates → file in list
- QR overlay appears → copy link
- Paste image from clipboard → upload
- Set 1hr expiry → file expires → gone from list
- Multi-file → ZIP contains all files
- List/Grid toggle persists across reload

### Manual Security
- [ ] Nikto scan
- [ ] OWASP ZAP baseline
- [ ] Verify /storage contains only UUIDs
- [ ] Confirm Cloudflare Tunnel is only access path (block direct VPS IP)
- [ ] Verify no original filenames in logs

---

## Dependencies

```json
{
  "dependencies": {
    "fastify": "^4",
    "@fastify/helmet": "^11",
    "@fastify/rate-limit": "^9",
    "@fastify/cookie": "^9",
    "@fastify/multipart": "^8",
    "@fastify/static": "^7",
    "@fastify/websocket": "^10",
    "better-sqlite3": "^9",
    "@simplewebauthn/server": "^10",
    "otplib": "^12",
    "qrcode": "^1.5",
    "archiver": "^7",
    "file-type": "^19",
    "node-cron": "^3",
    "jose": "^5",
    "uuid": "^9"
  },
  "devDependencies": {
    "vitest": "^1",
    "@playwright/test": "^1",
    "supertest": "^6",
    "typescript": "^5",
    "esbuild": "^0.20"
  }
}
```

---

## VPS Directory Layout

```
/opt/filetransfer/
  app/
    src/
      routes/        auth.js, files.js, upload.js, history.js
      services/      encryption.js, file.js, auth.js, zip.js, watcher.js
      middleware/    jwt.js, csrf.js, fileType.js, pathSanitize.js
      db/            schema.sql, migrate.js, queries.js
      ws/            server.js, handlers.js
    frontend/
    package.json
    server.js
  storage/           (AES-256 blobs, UUID names only)
  chunks/            (temp, wiped post-finalize)
  db/
    filetransfer.db
    filetransfer.db.backup
  logs/
  .env               (root:root, mode 600, NOT in repo)
```

## systemd Service

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

## Required Env Vars

```env
MASTER_SECRET=<64 hex chars — HKDF input for file encryption>
JWT_SECRET=<64 hex chars — JWT signing>
CSRF_SECRET=<32 hex chars>
IP_HMAC_KEY=<32 hex chars — for audit log IP hashing>
DOMAIN=https://yourdomain.com
STORAGE_PATH=/opt/filetransfer/storage
CHUNKS_PATH=/opt/filetransfer/chunks
DB_PATH=/opt/filetransfer/db/filetransfer.db
PORT=3000
NODE_ENV=production
MAX_FILE_SIZE_MB=5120
```
