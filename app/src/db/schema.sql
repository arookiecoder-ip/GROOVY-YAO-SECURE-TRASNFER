PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS webauthn_credentials (
    id TEXT PRIMARY KEY,
    public_key BLOB NOT NULL,
    counter INTEGER NOT NULL DEFAULT 0,
    device_type TEXT,
    transports TEXT,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
);

CREATE TABLE IF NOT EXISTS totp_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    secret TEXT NOT NULL,
    enabled INTEGER DEFAULT 0,
    backup_codes TEXT,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
);

CREATE TABLE IF NOT EXISTS auth_challenges (
    id TEXT PRIMARY KEY,
    challenge TEXT NOT NULL,
    type TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    refresh_token TEXT NOT NULL UNIQUE,
    auth_method TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_seen_at INTEGER,
    ip_hash TEXT,
    revoked INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    storage_id TEXT NOT NULL UNIQUE,
    original_name TEXT NOT NULL,
    original_name_iv TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    encryption_iv TEXT NOT NULL,
    encryption_tag TEXT NOT NULL,
    expires_at INTEGER,
    created_at INTEGER NOT NULL,
    download_count INTEGER DEFAULT 0,
    status TEXT DEFAULT 'complete'
);
CREATE INDEX IF NOT EXISTS idx_files_expires_at ON files(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_files_status ON files(status);

CREATE TABLE IF NOT EXISTS uploads (
    id TEXT PRIMARY KEY,
    original_name TEXT NOT NULL,
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

CREATE TABLE IF NOT EXISTS upload_chunks (
    upload_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    size_bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    PRIMARY KEY (upload_id, chunk_index),
    FOREIGN KEY (upload_id) REFERENCES uploads(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS transfer_history (
    id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    file_id TEXT,
    size_bytes INTEGER,
    duration_ms INTEGER,
    ip_hash TEXT,
    timestamp INTEGER NOT NULL,
    metadata TEXT
);
CREATE INDEX IF NOT EXISTS idx_history_timestamp ON transfer_history(timestamp DESC);

CREATE TABLE IF NOT EXISTS app_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
