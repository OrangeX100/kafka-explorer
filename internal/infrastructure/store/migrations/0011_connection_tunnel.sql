-- 0011: per-connection SSH tunnel (jump host). The password or key
-- passphrase NEVER lands here — only tunnel_secret_ref into the OS
-- credential store (guarded by schema_guard_test, same as main SASL refs).
-- tunnel_host_key pins the jump host's first-seen public-key fingerprint
-- (trust-on-first-use); a later mismatch fails hard instead of connecting.
ALTER TABLE connections ADD COLUMN tunnel_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE connections ADD COLUMN tunnel_host TEXT;
ALTER TABLE connections ADD COLUMN tunnel_port INTEGER NOT NULL DEFAULT 0;
ALTER TABLE connections ADD COLUMN tunnel_user TEXT;
ALTER TABLE connections ADD COLUMN tunnel_auth TEXT;
ALTER TABLE connections ADD COLUMN tunnel_key_path TEXT;
ALTER TABLE connections ADD COLUMN tunnel_secret_ref TEXT;
ALTER TABLE connections ADD COLUMN tunnel_host_key TEXT;
