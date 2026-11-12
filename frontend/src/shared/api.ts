// Typed API layer: the only place that imports generated bindings.
// Components never call bindings directly — they call these functions.
import { t } from "./i18n.js";
import * as connectionHandler from "../../bindings/kafkaexplorer/internal/presentation/wails/connectionhandler.js";
import * as topicHandler from "../../bindings/kafkaexplorer/internal/presentation/wails/topichandler.js";
import * as messageHandler from "../../bindings/kafkaexplorer/internal/presentation/wails/messagehandler.js";
import * as groupHandler from "../../bindings/kafkaexplorer/internal/presentation/wails/grouphandler.js";

import type {
  AlterConfigInput,
  Connection,
  ConsumerGroupDetail,
  ConsumerGroupSummary,
  CreateTopicInput,
  DecodeResult,
  DeleteRecordsInput,
  FindRequest,
  FindResult,
  BrowseResult,
  OffsetResetPlan,
  OffsetResetTarget,
  ProduceInput,
  ProduceResult,
  ImportResult,
  ShareGroupAlterTarget,
  ShareGroupDetail,
  ShareGroupSummary,
  SaveInput,
  TestResult,
  TopicDetail,
  TopicSummary,
} from "./contracts.js";

// The generated modules are plain JS with JSDoc; re-export through our
// contract types so the rest of the app stays type-checked.
export const connectionsApi = {
  list: (): Promise<Connection[] | null> => connectionHandler.List() as never,
  // Pin/unpin: list-ordering preference, handled entirely on the backend.
  setPinned: (id: string, pinned: boolean): Promise<void> => connectionHandler.SetPinned(id, pinned) as never,
  // Reachability probe through the POOLED client (4s deadline on the Go
  // side) — drives the sidebar dot so a dead cluster never reads green.
  ping: (id: string): Promise<void> => connectionHandler.Ping(id) as never,
  // Export writes a JSON file (native save dialog) WITHOUT secrets; import
  // reads one back (path picked via the native open dialog first).
  exportConnections: (): Promise<string> => connectionHandler.ExportConnections() as never,
  importConnections: (path: string): Promise<ImportResult> => connectionHandler.ImportConnections(path) as never,
  save: (input: SaveInput): Promise<Connection> => connectionHandler.Save(input) as never,
  remove: (id: string): Promise<void> => connectionHandler.Delete(id) as never,
  // 断开连接: drops the pooled client; the saved config stays.
  disconnect: (id: string): Promise<void> => connectionHandler.Disconnect(id) as never,
  // 克隆连接: duplicates a saved connection (independent password copy) and
  // returns the new connection.
  clone: (id: string, newName: string): Promise<Connection> =>
    connectionHandler.CloneConnection(id, newName) as never,
  test: (conn: Connection, password?: string): Promise<TestResult> =>
    connectionHandler.Test(conn, password ?? "") as never,
};

export const topicsApi = {
  list: (connectionId: string): Promise<TopicSummary[] | null> =>
    topicHandler.List(connectionId) as never,
  detail: (connectionId: string, topic: string): Promise<TopicDetail> =>
    topicHandler.Detail(connectionId, topic) as never,
  create: (input: CreateTopicInput): Promise<void> => topicHandler.Create(input) as never,
  remove: (connectionId: string, topic: string): Promise<void> =>
    topicHandler.DeleteTopic(connectionId, topic) as never,
  alterConfig: (input: AlterConfigInput): Promise<void> =>
    topicHandler.AlterConfig(input) as never,
};

export const messagesApi = {
  browse: (req: {
    connectionId: string;
    topic: string;
    partition?: number;
    startOffset?: number;
    startTimestamp?: number;
    direction: string;
    limit: number;
  }): Promise<BrowseResult> => messageHandler.Browse(req) as never,
  find: (req: FindRequest): Promise<FindResult> => messageHandler.Find(req) as never,
  produce: (input: ProduceInput): Promise<ProduceResult> => messageHandler.Produce(input) as never,
  deleteRecords: (input: DeleteRecordsInput): Promise<void> =>
    messageHandler.DeleteRecords(input) as never,
};

export const groupsApi = {
  list: (connectionId: string): Promise<ConsumerGroupSummary[] | null> =>
    groupHandler.List(connectionId) as never,
  detail: (connectionId: string, group: string, topic: string): Promise<ConsumerGroupDetail> =>
    groupHandler.Detail(connectionId, group, topic) as never,
  resetOffset: (target: OffsetResetTarget): Promise<OffsetResetPlan[]> =>
    groupHandler.ResetOffset(target) as never,
  listShareGroups: (connectionId: string): Promise<ShareGroupSummary[] | null> =>
    groupHandler.ListShareGroups(connectionId) as never,
  shareGroupDetail: (connectionId: string, group: string): Promise<ShareGroupDetail> =>
    groupHandler.ShareGroupDetail(connectionId, group) as never,
  alterShareGroupOffset: (target: ShareGroupAlterTarget): Promise<void> =>
    groupHandler.AlterShareGroupOffset(target) as never,
  deleteShareGroupOffsets: (connectionId: string, group: string, topics: string[]): Promise<void> =>
    groupHandler.DeleteShareGroupOffsets(connectionId, group, topics) as never,
};

// Maps application-layer errors to i18n keys + raw detail, so the UI shows
// the right message class without string-matching all over the components.
// cleanDetail strips the transport noise around an application error:
// wails prefixes handler failures with "RuntimeError:" and our typed network
// errors carry the "broker unreachable" sentinel — both are presentation
// noise, the frontend title says the same thing in the user's language.
function cleanDetail(msg: string): string {
  return msg
    .replace(/^.*?RuntimeError:\s*/, "")
    // Domain sentinel prefixes are English class words; the Chinese sentence
    // that follows is the actual message.
    .replace(/^(?:invalid input|conflict|not found|authentication failed|broker unreachable):\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Error classes in check order: specific first, generic last. Each key maps
// to a title + a "|"-separated how-to-fix hint list in the locales.
export function classifyError(err: unknown): { key: string; detail: string } {
  const detail = cleanDetail(String(err ?? ""));
  // A recovered Go panic is an application bug, not bad user input — the
  // "invalid memory address" text must not classify as 输入无效.
  if (/panic|memory address/.test(detail)) return { key: "error.generic", detail };
  // Backend-wrapped guidance messages are already user-facing sentences.
  if (/不支持 Share Groups/.test(detail)) return { key: "error.shareUnsupported", detail };
  // Schema Registry REST error codes surface as "registry 404: <msg>; error
  // code: 40401" — classify by code before the generic not-found catch.
  if (/error code: 40401|Subject "?\w+"? not found/i.test(detail)) return { key: "error.regSubjectMissing", detail };
  if (/error code: 4040[23]|Version not found|Schema \d+ not found/i.test(detail)) return { key: "error.regVersionMissing", detail };
  if (/error code: 4090[13]|incompatible/i.test(detail)) return { key: "error.regIncompatible", detail };
  if (/error code: 422\d\d|Invalid schema|invalid version/i.test(detail)) return { key: "error.regInvalidSchema", detail };
  if (/连接被拒绝|actively refused|refused/i.test(detail)) return { key: "error.refused", detail };
  if (/连接超时|timed?\s?out|deadline/i.test(detail)) return { key: "error.timeout", detail };
  if (/无法解析主机|no such host|could not resolve|lookup/i.test(detail)) return { key: "error.dns", detail };
  if (/TLS 握手|certificate|x509|handshake|tls:/i.test(detail)) return { key: "error.tls", detail };
  if (/name is required/i.test(detail)) return { key: "error.nameRequired", detail };
  if (/is not host:port|bootstrap entry/i.test(detail)) return { key: "error.badBootstrap", detail };
  if (/组正在被消费|NON_EMPTY_GROUP/i.test(detail)) return { key: "error.groupNotEmpty", detail };
  if (/组.*不存在|GROUPID_NOT_FOUND|group.*not found|has no offset/i.test(detail)) return { key: "error.groupMissing", detail };
  if (/正在重新平衡|REBALANCE_IN_PROGRESS|UNKNOWN_MEMBER_ID|MEMBER_ID_REQUIRED|stale member/i.test(detail)) return { key: "error.rebalance", detail };
  if (/COORDINATOR_NOT_AVAILABLE|NOT_COORDINATOR|COORDINATOR_LOAD_IN_PROGRESS/i.test(detail)) return { key: "error.coordinator", detail };
  if (/认证失败|auth|sasl/i.test(detail)) return { key: "error.auth", detail };
  if (/not authorized|unauthorized|forbidden|denied|授权/i.test(detail)) return { key: "error.denied", detail };
  if (/UNSUPPORTED_VERSION|不支持.*需要 Kafka/i.test(detail)) return { key: "error.unsupportedVersion", detail };
  if (/already exists|已存在/i.test(detail)) return { key: "error.conflict", detail };
  if (/不存在|not found/i.test(detail)) return { key: "error.notFound", detail };
  if (/输入无效|invalid/i.test(detail)) return { key: "error.invalid", detail };
  if (/无法连接|unreachable|connect/i.test(detail)) return { key: "error.unavailable", detail };
  return { key: "error.generic", detail };
}

// Error classes whose detail is pure address/port fact — the category title
// plus the hint panel say everything useful, repeating "1.2.3.4:9092 连接被拒
// 绝" in a toast adds noise, not information.
const FACT_ONLY_KEYS = new Set([
  "error.refused",
  "error.timeout",
  "error.dns",
  "error.tls",
  "error.unavailable",
  // Validation details are raw English domain strings ("bootstrap entry …
  // is not host:port") — the title plus the form is what the user needs.
  "error.nameRequired",
  "error.badBootstrap",
  "error.invalid",
]);

// friendlyError renders an error for a one-line toast: the classified title,
// plus the detail when that detail itself is actionable (backend-generated
// Chinese guidance like "Share 组正在被消费，无法…"). Long or fact-only
// details stay out; the panel/detail view carries them.
export function friendlyError(err: unknown): string {
  const { key, detail } = classifyError(err);
  const title = t(key);
  if (FACT_ONLY_KEYS.has(key)) return title;
  // Backend-written Chinese sentences ("连接名称 "x" 已存在", share guidance)
  // are complete messages on their own — no need to prefix the class title.
  if (/^[一-鿿]/.test(detail) && detail.length <= 90) return detail;
  if (detail && detail.length <= 90) return `${title}：${detail}`;
  return title;
}

// errorHints returns the how-to-fix bullet list for an error class; locales
// store them as one "|"-separated string under "<key>.hint".
export function errorHints(key: string): string[] {
  const raw = t(`${key}.hint`);
  return raw === key ? [] : raw.split("|").filter((h) => h.trim().length > 0);
}

// ---- P2 services ----
import * as adminHandler from "../../bindings/kafkaexplorer/internal/presentation/wails/adminhandler.js";
import * as schemaRegistryHandler from "../../bindings/kafkaexplorer/internal/presentation/wails/schemaregistryhandler.js";
import * as generateHandler from "../../bindings/kafkaexplorer/internal/presentation/wails/generatehandler.js";
import * as settingsHandler from "../../bindings/kafkaexplorer/internal/presentation/wails/settingshandler.js";
import * as systemHandler from "../../bindings/kafkaexplorer/internal/presentation/wails/systemhandler.js";

import type {
} from "./contracts.js";
import type {
  ACL,
  AppSettings,
  AppInfo,
  BackupCounts,
  UpdateCheck,
  BrokerDetail,
  BrokerSummary,
  RateBucket,
  RateScanWindow,
  QuorumInfo,
  ClusterDiff,
  CompatibilityCheck,
  ExportMessagesInput,
  GenerateInput,
  GenerateResult,
  GlobalConfig,
  LocalSchema,
  LogDir,
  Quota,
  RegistrySaveInput,
  SchemaRegistry,
  SchemaRegisterResult,
  SchemaSubject,
  SchemaVersion,
  AlterBrokerConfigInput,
  ImportFileInput,
  ImportFileResult,
} from "./contracts-admin.js";

export const adminApi = {
  listBrokers: (connectionId: string): Promise<BrokerSummary[] | null> =>
    adminHandler.ListBrokers(connectionId) as never,
  brokerDetail: (connectionId: string, brokerId: number): Promise<BrokerDetail> =>
    adminHandler.BrokerDetail(connectionId, brokerId) as never,
  describeQuorum: (connectionId: string): Promise<QuorumInfo | null> =>
    adminHandler.DescribeQuorum(connectionId) as never,
  alterBrokerConfig: (input: AlterBrokerConfigInput): Promise<void> =>
    adminHandler.AlterBrokerConfig(input) as never,
  listLogDirs: (connectionId: string): Promise<LogDir[] | null> =>
    adminHandler.ListLogDirs(connectionId) as never,
  listACLs: (connectionId: string): Promise<ACL[] | null> =>
    adminHandler.ListACLs(connectionId) as never,
  createACL: (connectionId: string, acl: ACL): Promise<void> =>
    adminHandler.CreateACL(connectionId, acl) as never,
  deleteACL: (connectionId: string, acl: ACL): Promise<void> =>
    adminHandler.DeleteACL(connectionId, acl) as never,
  listQuotas: (connectionId: string): Promise<Quota[] | null> =>
    adminHandler.ListQuotas(connectionId) as never,
  alterQuota: (connectionId: string, entity: Record<string, string>, key: string, value: number | null): Promise<void> =>
    adminHandler.AlterQuota(connectionId, entity, key, value) as never,
  deleteGroup: (connectionId: string, group: string): Promise<void> =>
    adminHandler.DeleteConsumerGroup(connectionId, group) as never,
  increasePartitions: (connectionId: string, topic: string, target: number): Promise<void> =>
    adminHandler.IncreasePartitions(connectionId, topic, target) as never,
  clusterDiff: (connectionA: string, connectionB: string): Promise<ClusterDiff> =>
    adminHandler.ClusterDiff(connectionA, connectionB) as never,
};

export const registryApi = {
  list: (): Promise<SchemaRegistry[] | null> => schemaRegistryHandler.List() as never,
  save: (input: RegistrySaveInput): Promise<SchemaRegistry> => schemaRegistryHandler.Save(input) as never,
  remove: (id: string): Promise<void> => schemaRegistryHandler.Delete(id) as never,
  test: (registry: SchemaRegistry, password?: string): Promise<string> =>
    schemaRegistryHandler.Test(registry, password ?? "") as never,
  subjects: (registryId: string): Promise<SchemaSubject[] | null> =>
    schemaRegistryHandler.Subjects(registryId) as never,
  versions: (registryId: string, subject: string): Promise<SchemaVersion[]> =>
    schemaRegistryHandler.Versions(registryId, subject) as never,
  compatibility: (registryId: string, subject: string, schema: string, schemaType: string): Promise<CompatibilityCheck> =>
    schemaRegistryHandler.Compatibility(registryId, subject, schema, schemaType) as never,
  validateSchema: (schemaType: string, schema: string): Promise<void> =>
    schemaRegistryHandler.ValidateSchema(schemaType, schema) as never,
  registerSchema: (registryId: string, subject: string, schema: string, schemaType: string): Promise<SchemaRegisterResult> =>
    schemaRegistryHandler.RegisterSchema(registryId, subject, schema, schemaType) as never,
  compatibilityVersion: (registryId: string, subject: string, version: number, schema: string, schemaType: string): Promise<CompatibilityCheck> =>
    schemaRegistryHandler.CompatibilityVersion(registryId, subject, version, schema, schemaType) as never,
  deleteSubject: (registryId: string, subject: string, permanent?: boolean): Promise<void> =>
    schemaRegistryHandler.DeleteSubject(registryId, subject, permanent ?? false) as never,
  deleteVersion: (registryId: string, subject: string, version: number, permanent?: boolean): Promise<number> =>
    schemaRegistryHandler.DeleteVersion(registryId, subject, version, permanent ?? false) as never,
  setSubjectConfig: (registryId: string, subject: string, level: string): Promise<void> =>
    schemaRegistryHandler.SetSubjectConfig(registryId, subject, level) as never,
  globalConfig: (registryId: string): Promise<GlobalConfig> =>
    schemaRegistryHandler.GlobalConfig(registryId) as never,
  setGlobalConfig: (registryId: string, level: string): Promise<void> =>
    schemaRegistryHandler.SetGlobalConfig(registryId, level) as never,
  listLocal: (): Promise<LocalSchema[] | null> => schemaRegistryHandler.ListLocalSchemas() as never,
  saveLocal: (schema: LocalSchema): Promise<LocalSchema> => schemaRegistryHandler.SaveLocalSchema(schema) as never,
  removeLocal: (id: string): Promise<void> => schemaRegistryHandler.DeleteLocalSchema(id) as never,
  decodeLocal: (schemaType: string, schema: string, payloadBase64: string): Promise<DecodeResult> =>
    schemaRegistryHandler.DecodeLocal(schemaType, schema, payloadBase64) as never,
};

export const generateApi = {
  generate: (input: GenerateInput): Promise<GenerateResult> => generateHandler.Generate(input) as never,
  export: (input: ExportMessagesInput): Promise<string> => generateHandler.Export(input) as never,
  exportToFile: (input: ExportMessagesInput, path: string): Promise<number> =>
    generateHandler.ExportToFile(input, path) as never,
  import: (input: GenerateInput): Promise<GenerateResult> => generateHandler.Import(input) as never,
  importFromFile: (input: ImportFileInput): Promise<ImportFileResult> =>
    generateHandler.ImportFromFile(input) as never,
};

import * as connectHandler from "../../bindings/kafkaexplorer/internal/presentation/wails/connecthandler.js";
import type { ConnectCluster, ConnectClusterSaveInput } from "./contracts-admin.js";
import type { ConnectorSummary } from "./contracts-admin.js";
import type { CreateConnectorInput } from "./contracts-admin.js";

export const connectApi = {
  list: (): Promise<ConnectCluster[] | null> => connectHandler.List() as never,
  save: (input: ConnectClusterSaveInput): Promise<ConnectCluster> => connectHandler.Save(input) as never,
  remove: (id: string): Promise<void> => connectHandler.Delete(id) as never,
  test: (url: string, username?: string, password?: string): Promise<string> => connectHandler.Test(url, username ?? "", password ?? "") as never,
  connectors: (clusterId: string): Promise<ConnectorSummary[] | null> =>
    connectHandler.Connectors(clusterId) as never,
  detail: (clusterId: string, name: string) => connectHandler.Detail(clusterId, name) as never,
  plugins: (clusterId: string): Promise<string[]> => connectHandler.Plugins(clusterId) as never,
  lifecycle: (clusterId: string, name: string, op: "restart" | "pause" | "resume"): Promise<void> =>
    (op === "restart" ? connectHandler.Restart(clusterId, name)
      : op === "pause" ? connectHandler.Pause(clusterId, name)
      : connectHandler.Resume(clusterId, name)) as never,
  createConnector: (input: CreateConnectorInput): Promise<void> => connectHandler.CreateConnector(input) as never,
  removeConnector: (clusterId: string, name: string): Promise<void> => connectHandler.DeleteConnector(clusterId, name) as never,
  updateConnector: (clusterId: string, name: string, config: Record<string, string>): Promise<void> =>
    connectHandler.UpdateConnector(clusterId, name, config) as never,
  restartTask: (clusterId: string, name: string, taskId: number): Promise<void> =>
    connectHandler.RestartTask(clusterId, name, taskId) as never,
};

export const settingsApi = {
  get: (): Promise<AppSettings> => settingsHandler.Get() as never,
  save: (s: AppSettings): Promise<AppSettings> => settingsHandler.Save(s) as never,
  // one-file backup across every persisted module (settings page 备份/恢复)
  exportBackup: (): Promise<string> => settingsHandler.ExportBackup() as never,
  importBackup: (path: string): Promise<BackupCounts> => settingsHandler.ImportBackup(path) as never,
};

export const systemApi = {
  info: (): Promise<AppInfo> => systemHandler.GetAppInfo() as never,
  // ✕ button: hide to tray or quit, per the CloseToTray setting (Go side
  // reads the current value at close time).
  closeToTray: (): Promise<void> => systemHandler.CloseToTray() as never,
  // Native file dialogs. "" = the user cancelled (callers treat as no-op).
  pickOpenFile: (title: string, pattern: string): Promise<string> =>
    systemHandler.PickOpenFile(title, pattern) as never,
  pickSaveFile: (title: string, defaultName: string, pattern: string): Promise<string> =>
    systemHandler.PickSaveFile(title, defaultName, pattern) as never,
  // Content reader for files the user just picked (schema uploads, imports).
  readTextFile: (path: string): Promise<string> => systemHandler.ReadTextFile(path) as never,
  checkUpdate: (repo: string): Promise<UpdateCheck> => systemHandler.CheckUpdate(repo) as never,
  stageUpdate: (repo: string, assetUrl: string, assetSize: number, requestId: string): Promise<void> =>
    systemHandler.StageUpdate(repo, assetUrl, assetSize, requestId) as never,
  cancelUpdate: (): Promise<void> => systemHandler.CancelUpdate() as never,
  installStaged: (stagedPath: string, relaunch: boolean): Promise<void> =>
    systemHandler.InstallStaged(stagedPath, relaunch) as never,
};

export const topicApi = {
  rateHistogram: (connectionId: string, topic: string, win: RateScanWindow, buckets: number, partition: number): Promise<[RateBucket[], number]> =>
    topicHandler.TopicRateHistogram(connectionId, topic, win, buckets, partition) as never,
};
export { ksqlDbApi } from "./api-ksqldb.js";
