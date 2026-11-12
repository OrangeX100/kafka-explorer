// Hand-written DTO contracts. This file is the frontend's only type source
// of truth for backend data: components import from here, never from the
// generated bindings' models directly. audit-dto.mjs compares these field
// lists against the generated models and fails the gate on drift.
//
// Generated bindings live in ../bindings (gitignored); the *service call*
// wrappers import from there, but types flow through this file.

export interface TunnelSettings {
  enabled: boolean;
  host?: string;
  /** 0/absent = 22. */
  port?: number;
  user?: string;
  /** "password" | "key". */
  auth?: string;
  keyPath?: string;
  secretRef?: string;
  /** First-seen jump-host fingerprint (TOFU); backend-owned. */
  hostKey?: string;
}

export interface Connection {
  id: string;
  name: string;
  bootstrap: string;
  security: string;
  username?: string;
  secretRef?: string;
  tls: TlsSettings;
  /** Backend struct is non-optional on the wire — the dialog always sends it. */
  tunnel: TunnelSettings;
  // Optional: unsaved connections have no timestamps (backend FlexTime
  // tolerates both absent and empty-string forms).
  createdAt?: string;
  updatedAt?: string;
  // Pinned connections sort first (favorites pinning); a view preference only.
  pinned?: boolean;
}

// ImportResult summarizes a connection-file import (see backend
// connection_io.go): passwordless SASL entries are named in needPassword.
export interface ImportResult {
  imported: number;
  skipped: number;
  needPassword?: string[];
}

export interface TlsSettings {
  enabled: boolean;
  caCertPath?: string;
  clientCertPath?: string;
  clientKeyPath?: string;
  insecureSkipVerify?: boolean;
}

export interface SaveInput {
  connection: Connection;
  password?: string;
  /** SSH tunnel password / key passphrase (write-only). */
  tunnelPassword?: string;
}

export interface TestResult {
  success: boolean;
  brokers?: string[];
  error?: string;
  elapsedMs: number;
}

export interface TopicSummary {
  name: string;
  partitions: number;
  replicationFactor: number;
  messageCount: number;
  internal: boolean;
  createdAt?: string;
}

export interface PartitionSummary {
  id: number;
  leader: number;
  replicas: number[];
  isr: number[];
  logStart: number;
  logEnd: number;
  messageCount: number;
}

export interface ConfigEntry {
  name: string;
  value: string;
  defaultValue: string;
  default: boolean;
  readOnly: boolean;
  sensitive: boolean;
  doc?: string;
}

export interface TopicDetail {
  name: string;
  partitions: number;
  replicationFactor: number;
  messageCount: number;
  internal: boolean;
  createdAt?: string;
  partitionList: PartitionSummary[];
  config: ConfigEntry[];
}

export interface MessageHeader {
  key: string;
  value: string;
}

export interface DecodeResult {
  format: string;
  text: string;
  error?: string;
}

export interface Message {
  topic: string;
  partition: number;
  offset: number;
  timestamp: string;
  key?: string;
  value?: string;
  valueSize: number;
  headers?: MessageHeader[];
  decoded?: DecodeResult;
}

export interface BrowseRequest {
  connectionId: string;
  topic: string;
  partition?: number;
  startOffset?: number;
  startTimestamp?: number;
  direction: "forward" | "backward";
  limit: number;
  decode?: string; // auto | json | text
}

export interface BrowsePage {
  messages: Message[] | null;
  nextAnchor?: number;
  exhausted: boolean;
}

export interface BrowseResult {
  page: BrowsePage;
  nextOffset?: number;
  exhausted: boolean;
}

export interface FindRequest {
  connectionId: string;
  topic: string;
  partition?: number;
  startOffset?: number;
  startTimestamp?: number;
  direction: 'forward' | 'backward';
  limit: number;
  decode?: string;
  pattern: string;
  regex: boolean;
  matchKey: boolean;
  matchValue: boolean;
  maxScan: number;
}

export interface FindResult {
  page: BrowsePage;
  nextOffset?: number;
  exhausted: boolean;
  scanned: number;
}

export interface ProduceInput {
  connectionId: string;
  topic: string;
  partition?: number;
  key?: string;
  value?: string;
  headers?: MessageHeader[];
}

export interface ProduceResult {
  partition: number;
  offset: number;
}

export interface DeleteRecordsInput {
  connectionId: string;
  topic: string;
  offset: number;
  partitions?: number[];
}

export interface ConsumerGroupSummary {
  group: string;
  state: string;
  members: number;
  protocolType: string;
  totalLag: number;
  type: string; // classic | consumer | share | streams | connect
}

// ---- Share groups (KIP-932, Kafka 4.2+) ----

export interface ShareGroupSummary {
  group: string;
  state: string;
  members: number;
  coordinatorId: number;
  subscribed: string[];
}

export interface ShareMember {
  id: string;
  clientId: string;
  host: string;
  rack?: string;
  memberEpoch: number;
  subscribed: string[];
  assignment: string[];
}

export interface SharePartitionOffset {
  topic: string;
  partition: number;
  startOffset: number;
  logEnd: number;
  lag: number; // broker-computed; -1 when unavailable
}

export interface ShareGroupDetail {
  group: string;
  state: string;
  assignor: string;
  groupEpoch: number;
  assignmentEpoch: number;
  members: ShareMember[];
  offsets: SharePartitionOffset[];
  totalLag: number;
}

export interface ShareGroupAlterTarget {
  connectionId: string;
  group: string;
  topic: string;
  partition: number;
  startOffset: number;
}

export interface GroupMember {
  id: string;
  clientId: string;
  host: string;
  assignment: string[];
}

export interface GroupPartitionOffset {
  topic: string;
  partition: number;
  committed: number;
  logEnd: number;
  lag: number;
}

export interface ConsumerGroupDetail {
  group: string;
  state: string;
  members: GroupMember[];
  offsets: GroupPartitionOffset[];
  totalLag: number;
}

export interface OffsetResetTarget {
  connectionId: string;
  group: string;
  topic: string;
  partitions: number[];
  mode: "earliest" | "latest" | "absolute" | "timestamp";
  absolute?: number;
  timestamp?: number;
  dryRun: boolean;
}

export interface OffsetResetPlan {
  partition: number;
  committed: number;
  newOffset: number;
  logEnd: number;
}

export interface CreateTopicInput {
  connectionId: string;
  name: string;
  partitions: number;
  replicationFactor: number;
  configs?: Record<string, string | null>;
}

// Topic config alter payload (application.AlterConfigInput on the Go side).
export interface AlterConfigInput {
  connectionId: string;
  topic: string;
  values: Record<string, string | null>;
}
