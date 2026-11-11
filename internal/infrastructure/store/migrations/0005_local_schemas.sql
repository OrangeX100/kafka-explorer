-- 0005: offline local schema library (registry-independent decode source).
-- Schemas themselves are not secrets; no password columns by design.
CREATE TABLE local_schemas (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    schema_type TEXT NOT NULL DEFAULT 'AVRO',
    schema     TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
