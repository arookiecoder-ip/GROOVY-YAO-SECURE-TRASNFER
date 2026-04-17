# Groovy YAO — TODO

## Phase 1 — Foundation ✅
- [x] Init Node.js project, Fastify, TypeScript config
- [x] SQLite migration script, create all tables
- [x] Fastify plugins: Helmet, rate-limit, cookie, multipart, static, websocket
- [x] EncryptionService — HKDF key derivation, AES-256-GCM stream encrypt/decrypt
- [x] Env var validation on startup (crash-fast)
- [x] Health endpoint GET /api/health
- [x] Frontend: HTML shell, CSS design system tokens, boot animation

## Phase 2 — Authentication ✅
- [x] First-run detection (no credentials → setup wizard)
- [x] WebAuthn registration flow (begin + complete endpoints)
- [x] WebAuthn authentication flow (begin + complete endpoints)
- [x] TOTP setup (secret gen, QR provision, confirm-first-code)
- [x] TOTP verification endpoint
- [x] JWT issuance + refresh token rotation + logout
- [x] Auth middleware protecting all /api/* except auth endpoints
- [x] Frontend: passkey button wired, TOTP fallback input wired, setup wizard

## Phase 3 — Core File Operations ✅
- [x] Simple upload endpoint (< 10MB, sync, encrypts to disk)
- [x] Download endpoint (decrypt stream, correct Content-Disposition)
- [x] File listing endpoint (sort/filter/page)
- [x] File delete endpoint (disk + DB cleanup)
- [x] Expiry watcher cron
- [x] Frontend: DropZone drag-and-drop, file queue, simple upload
- [x] Frontend: FileManager list view
- [x] Frontend: Download + delete actions

## Phase 4 — Chunked Upload + Resume ✅
- [x] Upload init + per-chunk endpoint + finalize + abort
- [x] Chunk assembly with SHA-256 verification
- [x] Resume: init returns already-received chunk indices
- [x] SHA-256 Web Worker (hashWorker.js)
- [x] Frontend: UploadManager chunking logic (5MB chunks, 3-retry backoff)
- [x] Frontend: resume on reconnect

## Phase 5 — Real-Time 🔲
- [ ] WebSocket server (JWT auth on Upgrade request)
- [ ] Server emits UPLOAD_PROGRESS per chunk
- [ ] Server emits UPLOAD_COMPLETE / DOWNLOAD_READY
- [ ] Frontend: WebSocketClient singleton + reconnect
- [ ] Frontend: CyberpunkProgressBar (WS-driven, segmented, neon glow)
- [ ] Frontend: SpeedOMeter
- [ ] Frontend: Toast notifications for WS events
- [ ] Cross-device push (upload on laptop → phone gets WS notification)

## Phase 6 — Enhanced Features 🔲
- [ ] QR code generation endpoint + frontend overlay
- [ ] Clipboard paste handler (images + files)
- [ ] Multi-file + folder upload → ZIP streaming
- [ ] Transfer history endpoint + history view
- [ ] Extend expiry action
- [ ] Grid view toggle in FileManager
- [ ] Stats endpoint + dashboard widget

## Phase 7 — Hardening + Deployment 🔲
- [ ] Full security checklist audit
- [ ] file-type MIME validation integrated
- [ ] npm audit — 0 high/critical
- [ ] cloudflared tunnel setup + DNS config
- [ ] systemd service file (non-root user, resource limits)
- [ ] .env setup (not in repo, mode 600)
- [ ] Log rotation config
- [ ] Daily SQLite backup script
- [ ] Load test: 2GB file upload with autocannon
