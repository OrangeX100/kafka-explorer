import * as ksqlDbHandler from "../../bindings/kafkaexplorer/internal/presentation/wails/ksqldbhandler.js";
import type { KsqlDbSaveInput } from "./contracts-admin.js";

export const ksqlDbApi = {
  list: (): Promise<import("./contracts-admin.js").KsqlDbServer[] | null> => ksqlDbHandler.List() as never,
  save: (input: KsqlDbSaveInput): Promise<import("./contracts-admin.js").KsqlDbServer> => ksqlDbHandler.Save(input) as never,
  remove: (id: string): Promise<void> => ksqlDbHandler.Delete(id) as never,
  test: (url: string, username?: string, password?: string): Promise<[string, string, string]> =>
    ksqlDbHandler.Test(url, username ?? "", password ?? "") as never,
  info: (serverId: string): Promise<[string, string, string]> => ksqlDbHandler.Info(serverId) as never,
  exec: (serverId: string, ksql: string): Promise<import("./contracts-admin.js").KsqlExecResult> =>
    ksqlDbHandler.Exec(serverId, ksql) as never,
  query: (serverId: string, sql: string, requestId: string): Promise<void> =>
    ksqlDbHandler.Query(serverId, sql, requestId) as never,
  cancel: (requestId: string): Promise<void> => ksqlDbHandler.Cancel(requestId) as never,
};
