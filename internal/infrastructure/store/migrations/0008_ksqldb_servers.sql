-- 0008: ksqlDB servers (ksqlDB module parity).
-- Same discipline as registries/connect: URL is non-secret; API secrets go
-- to the OS credential store behind secret_ref.
CREATE TABLE ksql_db_servers (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    url        TEXT NOT NULL,
    username   TEXT,
    secret_ref TEXT
);
