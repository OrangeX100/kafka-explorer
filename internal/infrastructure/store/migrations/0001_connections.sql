-- 0001: connection metadata. Passwords live in the OS credential store
-- (referenced by secret_ref), never in this table — enforced by
-- schema_guard_test.go.
CREATE TABLE connections (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    bootstrap   TEXT NOT NULL,
    security    TEXT NOT NULL DEFAULT 'none',
    username    TEXT,
    secret_ref  TEXT,
    tls_enabled INTEGER NOT NULL DEFAULT 0,
    tls_ca_cert_path         TEXT,
    tls_client_cert_path     TEXT,
    tls_client_key_path      TEXT,
    tls_insecure_skip_verify INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);

CREATE INDEX idx_connections_name ON connections(name);
