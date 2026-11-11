-- 0004: Kafka Connect endpoints (non-secret: URL only).
CREATE TABLE connect_clusters (
    id   TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    url  TEXT NOT NULL
);
