-- 0009: the connect_clusters.secret_ref column was missed when auth landed
-- (0007 added only username) — every ListConnectClusters SELECT failed with
-- "no such column" after the auth round. Fresh installs of 0007+0009 are
-- no-ops relative to intent; existing DBs get the missing column here.
ALTER TABLE connect_clusters ADD COLUMN secret_ref TEXT;
