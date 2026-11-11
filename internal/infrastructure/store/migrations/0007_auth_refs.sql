-- 0007: auth references for Connect clusters and Schema Registries.
-- Passwords/API secrets NEVER live here — only the username and a reference
-- into the OS credential store (guarded by schema_guard_test). The missing
-- secret_ref column made registry SecretRefs evaporate on restart: the
-- handler stored the ref into the struct but there was no column to land in.
ALTER TABLE connect_clusters ADD COLUMN username TEXT;
ALTER TABLE schema_registries ADD COLUMN secret_ref TEXT;
