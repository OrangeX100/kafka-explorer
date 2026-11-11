-- 0002: schema registry connections. No password columns — basic-auth
-- passwords go to the OS credential store (guarded by schema_guard_test).
CREATE TABLE schema_registries (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    url        TEXT NOT NULL,
    username   TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
