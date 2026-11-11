import { useCallback, useEffect, useState } from "react";
import { adminApi, friendlyError } from "../../shared/api.js";
import type { LogDir } from "../../shared/contracts-admin.js";
import { useToast } from "../../state/stores.js";
import { t } from "../../shared/i18n.js";
import { SkeletonLines } from "../common/Skeleton.js";
import { EmptyState } from "../common/EmptyState.js";
import { formatBytes } from "../../shared/format.js";
import { Copy, Pencil, Plus, Server } from "lucide-react";
import { configName, configDesc } from "../../shared/configLocale.js";
import { useCopy } from "../../shared/useCopy.js";
import { configHint } from "../../shared/humanize.js";
import type { QuorumInfo } from "../../shared/contracts-admin.js";
import { BrokerConfigEditDialog } from "./BrokerConfigDialogs.js";
import { AddConfigDialog } from "../topics/ConfigDialogs.js";
import { BROKER_CONFIG_DOCS } from "../../shared/brokerConfigDocsMeta.js";
import { useContextMenu } from "../common/ContextMenu.js";
import type { BrokerDetail, BrokerSummary, ConfigEntry } from "../../shared/contracts-admin.js";
import { ErrorHint } from "../common/ErrorHint.js";

// BrokersView: broker list + config/log-dir detail of the selected broker.
// Configs render read-only (edit opens a dialog — one stray click must not
// mutate a broker); readOnly=true configs are restart-only and never
// editable. Same interaction pattern as the topic config page.
export function BrokersView({ connectionId }: { connectionId: string }) {
  const [brokers, setBrokers] = useState<BrokerSummary[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<BrokerDetail | null>(null);
  const [editing, setEditing] = useState<ConfigEntry | null>(null);
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState("");
  const [quorum, setQuorum] = useState<QuorumInfo | null>(null);
  const [quorumError, setQuorumError] = useState<string | null>(null);
  const { open: openCtx, menu: ctxMenu } = useContextMenu();
  const copy = useCopy();
  // (s) => s.show: stable action identity — a whole-store useToast() here
  // rebuilt loadDetail on every toast and looped refetch+toast forever.
  const toast = { show: useToast((s) => s.show) };

  const load = useCallback(async () => {
    setBrokers(null);
    try {
      const list = (await adminApi.listBrokers(connectionId)) ?? [];
      setBrokers(list);
      // Functional update: the captured `selected` was stale on cluster
      // switches (the effect resetting it to null lands after load's
      // closure was built), which skipped the auto-select forever.
      if (list.length > 0) setSelected((cur) => cur ?? list[0].id);
    } catch (err) {
      setBrokers([]);
      setLoadError(err);
    }
  }, [connectionId]);

  // KRaft quorum status: best-effort companion data. ZooKeeper clusters
  // answer UNSUPPORTED_VERSION — the card renders a quiet note instead of
  // an error banner (it is a capability difference, not a failure).
  const loadQuorum = useCallback(async () => {
    setQuorum(null);
    setQuorumError(null);
    try {
      setQuorum(await adminApi.describeQuorum(connectionId));
    } catch (err) {
      setQuorumError(err instanceof Error ? err.message : String(err));
    }
  }, [connectionId]);

  useEffect(() => {
    setSelected(null);
    void load();
    void loadQuorum();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId]);

  const loadDetail = useCallback(
    async (brokerId: number) => {
      try {
        setDetail(await adminApi.brokerDetail(connectionId, brokerId));
      } catch (err) {
        toast.show(friendlyError(err), "error");
      }
    },
    [connectionId, toast],
  );

  useEffect(() => {
    if (selected === null) return;
    void loadDetail(selected);
  }, [selected, connectionId, loadDetail]);

  const [logDirs, setLogDirs] = useState<LogDir[] | null>(null);
  useEffect(() => {
    adminApi
      .listLogDirs(connectionId)
      .then((d) => setLogDirs(d ?? []))
      .catch(() => setLogDirs([]));
  }, [connectionId]);

  const configs = detail?.configs ?? [];
  const filtered = configs.filter((c) => !filter || c.name.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="flex h-full">
      <div className="flex w-60 flex-col border-r border-ink-700 bg-ink-900">
        <div className="flex-1 overflow-y-auto py-1">
          {brokers === null && (
            <div className="px-3 py-3">
              <SkeletonLines rows={3} />
            </div>
          )}
          {(brokers ?? []).map((b) => (
            <div
              key={b.id}
              data-testid="broker-row"
              onClick={() => {
                // Re-clicking the selected broker re-pulls its configs —
                // they are live cluster state.
                if (selected === b.id) void loadDetail(b.id);
                else setSelected(b.id);
              }}
              onContextMenu={(e) =>
                openCtx(e, [
                  // The list row has no "edit" concept — brokers are cluster
                  // facts. Before selection the useful action IS selecting;
                  // afterwards it's reloading the live configs (same as
                  // re-clicking the row). A fake "编辑" here was a no-op.
                  {
                    label: selected === b.id ? t("ctx.reloadConfigs") : t("ctx.selectBroker"),
                    onSelect: () => (selected === b.id ? void loadDetail(b.id) : setSelected(b.id)),
                  },
                  { label: t("ctx.copyBrokerId"), icon: <Copy size={13} />, onSelect: () => copy(String(b.id)) },
                  {
                    label: t("ctx.copyEndpoint"),
                    icon: <Copy size={13} />,
                    onSelect: () => copy(`${b.host}:${b.port}`),
                  },
                ])
              }
              className={`cursor-pointer px-3 py-1.5 text-xs ${
                selected === b.id ? "bg-accent-muted text-ink-100" : "text-ink-200 hover:bg-ink-800"
              }`}
            >
              <div className="font-mono">
                broker-{b.id} <span className="text-ink-400">{b.host}:{b.port}</span>
              </div>
              {b.rack && <div className="text-10 text-ink-400">rack: {b.rack}</div>}
            </div>
          ))}
          {loadError !== null && (
            <div className="px-3 py-4">
              <ErrorHint error={loadError} onRetry={() => void load()} />
            </div>
          )}
          {!loadError && brokers !== null && brokers.length === 0 && (
            <div className="px-3 py-4 text-xs text-ink-400">{t("brokers.empty")}</div>
          )}
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
      {ctxMenu}
        {/* KRaft quorum status card (DescribeQuorum): leader, voters and
            sync state. ZooKeeper clusters render a quiet "not KRaft" note
            instead of an error — a capability difference, not a failure. */}
        {quorum && (
          <div className="flex items-center gap-3 border-b border-ink-700 bg-ink-900 px-3 py-2 text-11">
            <span className="rounded bg-accent/15 px-1.5 py-0.5 font-medium text-accent">
              KRaft Quorum
            </span>
            <span className="text-ink-200">
              {t("quorum.leader")}: <span className="font-mono text-accent">{quorum.leaderId}</span>
              <span className="ml-1 text-ink-400">(epoch {quorum.leaderEpoch})</span>
            </span>
            <span className="text-ink-400">·</span>
            <span className="text-ink-300">
              HW <span className="font-mono">{quorum.highWatermark}</span>
            </span>
            <span className="flex-1" />
            <div className="flex items-center gap-1.5">
              {quorum.voters.map((v) => (
                <span
                  key={v.replicaId}
                  className={`flex items-center gap-1 rounded px-1.5 py-0.5 ${
                    v.isLeader ? "bg-accent-muted text-accent" : "bg-ink-800 text-ink-300"
                  }`}
                  title={`${t("quorum.role")}: ${v.role} · ${t("quorum.logEnd")}: ${v.logEndOffset}`}
                >
                  {v.isLeader ? "★" : "○"} {t("quorum.broker")} {v.replicaId}
                  <span className={v.synced ? "text-ok" : "text-warn"}>
                    {v.synced ? "✓" : "⟳"}
                  </span>
                </span>
              ))}
            </div>
          </div>
        )}
        {quorumError && (
          <div
            className="border-b border-ink-700 bg-ink-900 px-3 py-1.5 text-10 text-ink-400"
            title={quorumError}
          >
            {t("quorum.notKraft")}
          </div>
        )}
        <div className="flex items-center gap-1.5 border-b border-ink-700 bg-ink-900 px-2 py-1.5">
          <span className="text-11 text-ink-400">
            {t("config.stats", String(configs.length), String(configs.filter((c) => !c.default).length))}
          </span>
          <div className="flex-1" />
          <input
            className="field !w-44 !py-1"
            placeholder={t("config.filter")}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <button
            className="btn btn-accent !px-2 !py-1"
            title={t("config.add")}
            onClick={() => setAdding(true)}
          >
            <Plus size={13} /> {t("config.add")}
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {detail ? (
            <table className="table-fixed w-full border-collapse text-xs">
              <colgroup>
                <col className="w-[20%]" />
                <col className="w-[15%]" />
                <col className="w-[23%]" />
                <col className="w-[10%]" />
                <col className="w-[32%]" />
              </colgroup>
              <thead>
                <tr>
                  <th className="table-head px-2 py-1.5 text-left">{t("config.key")}</th>
                  <th className="table-head px-2 py-1.5 text-left">{t("config.zhName")}</th>
                  <th className="table-head px-2 py-1.5 text-left">{t("config.value")}</th>
                  <th className="table-head whitespace-nowrap px-2 py-1.5 text-left">{t("config.default")}</th>
                  <th className="table-head whitespace-nowrap px-2 py-1.5 text-center">{t("config.edit")}</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((c) => {
                  const editable = !c.readOnly && !c.sensitive;
                  const hint = configHint(c.name, c.value);
                  const label = configName(c.name);
                  const desc = configDesc(c.name, c.doc);
                  return (
                    <tr
                      key={c.name}
                      className="group border-b border-ink-800 hover:bg-ink-850"
                      onContextMenu={(e) =>
                        openCtx(e, [
                          {
                            label: editable ? t("config.edit") : t("config.view"),
                            icon: <Pencil size={13} />,
                            onSelect: () => setEditing(c),
                          },
                          { label: t("ctx.copyKeyName"), icon: <Copy size={13} />, onSelect: () => copy(c.name) },
                          { label: t("ctx.copyValue"), icon: <Copy size={13} />, onSelect: () => copy(c.sensitive ? "＊＊＊" : c.value) },
                          { label: t("ctx.copyDesc"), icon: <Copy size={13} />, onSelect: () => copy(desc) },
                        ])
                      }
                    >
                      <td
                        className="break-all px-2 py-1.5 align-top font-mono text-ink-200"
                        title={c.name}
                      >
                        {c.name}
                      </td>
                      <td className="break-all px-2 py-1.5 align-top text-ink-100" title={label}>
                        {label}
                      </td>
                      <td className="px-2 py-1.5">
                        {/* Human hint shows for BOTH editable and read-only
                            rows — a 需重启 static config with 60000 ms still
                            deserves ≈ 1 分钟. Click-to-edit stays editable-only. */}
                        <div
                          className={
                            editable
                              ? "-mx-1 block w-full max-w-full cursor-pointer rounded px-1 py-0.5 text-left transition-colors hover:bg-ink-800"
                              : "block"
                          }
                          title={editable ? `${t("config.edit")}：${c.name}` : c.sensitive ? "＊＊＊" : c.value}
                          onClick={editable ? () => setEditing(c) : undefined}
                        >
                          <span className="block break-all font-mono text-ink-100">
                            {c.sensitive ? "＊＊＊" : c.value || "∅"}
                          </span>
                          {hint && (
                            <span className="block break-all font-mono text-10 text-ink-400">{hint}</span>
                          )}
                        </div>
                      </td>
                      <td className="px-2 py-1.5">
                        {c.readOnly ? (
                          <span
                            className="whitespace-nowrap rounded bg-ink-700 px-1.5 py-0.5 text-10 text-ink-200"
                            title={t("config.staticHint")}
                          >
                            {t("config.staticBadge")}
                          </span>
                        ) : c.default ? (
                          <span className="text-11 text-ink-400">{t("config.defaultBadge")}</span>
                        ) : (
                          <span className="whitespace-nowrap rounded bg-accent-muted px-1.5 py-0.5 text-10 text-accent">{t("config.overrideBadge")}</span>
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-center">
                        <button
                          className={`btn !px-2 !py-0.5 text-10 ${editable ? "" : "opacity-70"}`}
                          title={editable ? t("config.edit") : t("config.viewTitle")}
                          onClick={() => setEditing(c)}
                        >
                          <Pencil size={11} /> {editable ? t("config.edit") : t("config.view")}
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-3 py-6 text-center text-xs text-ink-400">
                      {t("config.filter")} 0
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          ) : (
            <EmptyState icon={<Server size={20} />} title={t("ws.brokers")} desc={t("brokers.empty")} />
          )}
          {/* scroll-end spacer so the last row never clips */}
          <div className="h-3" />
        </div>
        {logDirs && logDirs.length > 0 && (
          <div className="border-t border-ink-700 bg-ink-900 px-2 py-1.5">
            <div className="flex flex-wrap gap-2 text-11">
              {logDirs.map((d, i) => (
                <span key={i} className="rounded border border-ink-700 px-2 py-0.5">
                  <span className="font-mono text-ink-200">{d.path}</span>
                  {d.totalBytes > 0 && (
                    <span className="ml-2 text-ink-400">
                      {formatBytes(d.totalBytes - d.usableBytes)} / {formatBytes(d.totalBytes)}
                    </span>
                  )}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {adding && detail && (
        <AddConfigDialog
          docs={BROKER_CONFIG_DOCS}
          existing={configs}
          alter={(name, value) =>
            adminApi.alterBrokerConfig({ connectionId, brokerId: detail.id, values: { [name]: value } })
          }
          onClose={() => setAdding(false)}
          onSaved={() => void loadDetail(detail.id)}
        />
      )}
      {editing && detail && (
        <BrokerConfigEditDialog
          connectionId={connectionId}
          brokerId={detail.id}
          entry={editing}
          onClose={() => setEditing(null)}
          onSaved={() => void loadDetail(detail.id)}
        />
      )}
    </div>
  );
}
