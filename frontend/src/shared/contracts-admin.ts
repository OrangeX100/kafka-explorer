// P2 DTO contracts (Schema Registry / Admin / Generate). Same discipline as
// contracts.ts: hand-written, compared to generated bindings by audit-dto.

import type { ConfigEntry } from "./contracts.js";
export type { ConfigEntry };


export interface SchemaRegistry {
  id: string;
  name: string;
  url: string;
  username?: string;
  secretRef?: string;
  /** Cluster binding: decoding on this connection resolves here first. Empty = global fallback. */
  connectionId?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface RegistrySaveInput {
  registry: SchemaRegistry;
  password?: string;
}

export interface SchemaRef {
  name: string;
  subject: string;
  version: number;
}

export interface SchemaSubject {
  name: string;
  version: number;
  id: number;
  schemaType: string;
  compatibility: string;
  schema: string;
  references?: SchemaRef[];
}

export interface SchemaVersion {
  version: number;
  id: number;
  schemaType: string;
  schema: string;
}

/** What a successful schema registration assigns (both ids are stable once set). */
export interface SchemaRegisterResult {
  id: number;
  version: number;
}

export interface CompatibilityCheck {
  isCompatible: boolean;
  messages?: string[];
}

export interface GlobalConfig {
  compatibilityLevel: string;
}

export interface LocalSchema {
  id: string;
  name: string;
  schemaType: string;
  schema: string;
  references?: SchemaRef[];
  createdAt?: string;
  updatedAt?: string;
}

export interface BrokerSummary {
  id: number;
  host: string;
  port: number;
  rack?: string;
}

export interface RateScanWindow {
  fromMs: number;
  fromOffset: number;
  byOffset: boolean;
}

export interface RateBucket {
  startMs: number;
  count: number;
}

export interface QuorumVoter {
  replicaId: number;
  role: string; // "voter" | "observer"
  logEndOffset: number;
  lastFetchMs: number; // -1 = leader or unknown
  synced: boolean;
  isLeader: boolean;
}

export interface QuorumInfo {
  leaderId: number;
  leaderEpoch: number;
  highWatermark: number;
  controllerEndpoint: string;
  voters: QuorumVoter[];
}

export interface BrokerDetail {
  id: number;
  host: string;
  port: number;
  rack?: string;
  configs: ConfigEntry[];
}

export interface AlterBrokerConfigInput {
  connectionId: string;
  brokerId: number;
  values: Record<string, string | null>;
}

export interface LogDir {
  brokerId: number;
  path: string;
  totalBytes: number;
  usableBytes: number;
  topics?: LogDirTopic[];
}

export interface LogDirTopic {
  topic: string;
  partition: number;
  sizeBytes: number;
  offsetLag?: number;
}

export interface ACL {
  principal: string;
  host: string;
  operation: string;
  permissionType: string;
  resourceType: string;
  resourceName: string;
  patternType: string;
}

export interface Quota {
  entity: Record<string, string>;
  values: Record<string, number>;
}

export interface ClusterDiff {
  topicsOnlyInA: string[];
  topicsOnlyInB: string[];
  both: TopicPairDiff[];
}

export interface TopicPairDiff {
  topic: string;
  partitionsA: number;
  partitionsB: number;
  partitionMatch: boolean;
  configDiffCount: number;
}

export interface GenerateInput {
  connectionId: string;
  topic: string;
  count: number;
  format: string;
  keyPrefix?: string;
  template: string;
}

export interface GenerateResult {
  produced: number;
  firstOffset: number;
  elapsedMs: number;
}

export interface ExportMessagesInput {
  connectionId: string;
  topic: string;
  /** -1 = all partitions (walked per-partition, ids ascending). */
  partition?: number;
  from: number;
  to?: number;
  format: string;
  /** Add schema-decoded rendering (decodedValue + format) to JSONL rows. */
  decoded?: boolean;
}

export interface ImportFileInput {
  connectionId: string;
  topic: string;
  path: string;
  partition?: number;
}

export interface ImportFileResult {
  produced: number;
  failed: number;
  firstOffset?: number;
  failedLines?: { line: number; error: string }[];
  elapsedMs: number;
}

export interface AppSettings {
  theme: string;
  locale: string;
  density: string;
  fontSize: number;
  fontFamily: string;
  // Latin font key ("" = follow the CJK stack): Latin letters/digits render
  // with this font, CJK characters fall through to fontFamily's stack.
  fontLatin: string;
  pageSize: number;
  showInternal: boolean;
  maxScan: number;
  updateRepo: string;
  autoCheckUpdate: boolean;
  // ✕ hides to the system tray instead of quitting (default on).
  closeToTray: boolean;
}

// ---- System / About ----

// BackupCounts summarizes one full-config import (settings page 备份/恢复):
// per-collection landing counts, skips, and the app preferences flag.
export interface BackupCounts {
  connections: number;
  registries: number;
  connectClusters: number;
  ksqlDbServers: number;
  localSchemas: number;
  settings: number;
  skipped: number;
  needPassword?: string[];
}

export interface AppInfo {
  version: string;
  commit: string;
  goVersion: string;
  os: string;
  arch: string;
  dataDir: string;
  logFile: string;
  startedAt: number;
}

export interface UpdateCheck {
  hasUpdate: boolean;
  current: string;
  latest: string;
  url: string;
  notes: string;
  assetUrl?: string;
  assetSize?: number;
  assetName?: string;
}

// ---- Kafka Connect ----

export interface ConnectorSummary {
  name: string;
  type: string;
  state: string;
  worker: string;
}

export interface ConnectorTask {
  id: number;
  state: string;
  worker: string;
  trace?: string;
}

export interface ConnectorDetail {
  name: string;
  type: string;
  state: string;
  worker: string;
  config: Record<string, string>;
  tasks: ConnectorTask[];
}

export interface ConnectCluster {
  id: string;
  name: string;
  url: string;
  username?: string;
  secretRef?: string;
}

export interface ConnectClusterSaveInput {
  cluster: ConnectCluster;
  password?: string;
}

export interface CreateConnectorInput {
  connectionId: string;
  name: string;
  config: Record<string, string>;
}

// ---- ksqlDB ----

export interface KsqlDbServer {
  id: string;
  name: string;
  url: string;
  username?: string;
  secretRef?: string;
}

export interface KsqlDbSaveInput {
  server: KsqlDbServer;
  password?: string;
}

export interface KsqlStreamRow {
  name: string;
  topic: string;
  keyFormat: string;
  valueFormat: string;
  windowType?: string;
}

export interface KsqlTableRow {
  name: string;
  topic: string;
  keyFormat: string;
  valueFormat: string;
  windowType?: string;
}

export interface KsqlQueryRow {
  id: string;
  queryType: string;
  status: string;
  sinkName?: string;
  sql?: string;
}

export interface KsqlExecResult {
  statementText: string;
  queryIds?: string[];
  warnings?: string[];
  streams?: KsqlStreamRow[];
  tables?: KsqlTableRow[];
  queries?: KsqlQueryRow[];
  properties?: Record<string, string>;
  genericEntity?: Record<string, unknown>;
}
