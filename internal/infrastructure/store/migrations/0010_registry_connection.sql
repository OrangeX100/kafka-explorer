-- 0010: per-connection registry binding. A registry bound to a connection
-- is the ONLY decoder source for that cluster; unbound registries stay the
-- fallback (and keep serving setups with one registry, pre-binding rows).
-- NULL/empty = global (unbound). Without the column, multi-cluster users
-- with same-numbered schema ids decoded against the wrong registry
-- (the decoder always took List()[0]).
ALTER TABLE schema_registries ADD COLUMN connection_id TEXT;
