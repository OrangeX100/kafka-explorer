-- 0006: connection pinning (OE favorites: pinned connections sort first).
ALTER TABLE connections ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
