import { useCallback, useEffect, useState } from "react";
import { Pencil, RefreshCw, Trash2 } from "lucide-react";
import { groupsApi, adminApi, friendlyError } from "../../shared/api.js";
import { useToast } from "../../state/stores.js";
import { t } from "../../shared/i18n.js";
import { confirmDialog } from "../common/ConfirmDialog.js";
import { formatNumber } from "../../shared/format.js";
import { SkeletonLines } from "../common/Skeleton.js";
import { EmptyState } from "../common/EmptyState.js";
import { Users } from "lucide-react";
import type { ConsumerGroupDetail, ConsumerGroupSummary } from "../../shared/contracts.js";
import { ResetOffsetDialog } from "./ResetOffsetDialog.js";
import { useContextMenu } from "../common/ContextMenu.js";
import { useCopy } from "../../shared/useCopy.js";
import { ErrorHint } from "../common/ErrorHint.js";

export function GroupsView({ connectionId }: { connectionId: string }) {
  const [groups, setGroups] = useState<ConsumerGroupSummary[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<ConsumerGroupDetail | null>(null);
  const [resetting, setResetting] = useState<string | null>(null);
  const [editingOffset, setEditingOffset] = useState<{ topic: string; partition: number; committed: number } | null>(null);
  const [detailTab, setDetailTab] = useState<"offsets" | "members">("offsets");
  // (s) => s.show: stable action identity — a whole-store useToast() here
  // rebuilt loadDetail on every toast and looped refetch+toast forever.
  const toast = { show: useToast((s) => s.show) };
  const { open: openCtx, menu: ctxMenu } = useContextMenu();
  const copy = useCopy();

  const load = useCallback(async () => {
    setGroups(null);
    setLoadError(null); // a stale failure banner must not outlive success
    try {
      setGroups((await groupsApi.list(connectionId)) ?? []);
    } catch (err) {
      setGroups([]);
      setLoadError(err);
    }
  }, [connectionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadDetail = useCallback(
    async (group: string) => {
      try {
        setDetail(await groupsApi.detail(connectionId, group, ""));
      } catch (err) {
        toast.show(friendlyError(err), "error");
      }
    },
    [connectionId, toast]
  );

  useEffect(() => {
    if (selected) void loadDetail(selected);
  }, [selected, loadDetail]);

  return (
    <div className="flex h-full">
      <div className="flex w-72 min-w-48 flex-col border-r border-ink-700 bg-ink-900">
        <div className="flex items-center border-b border-ink-700 px-2 py-1.5">
          <button className="btn" title={t("topics.refresh")} onClick={() => void load()}>
            <RefreshCw size={13} />
          </button>
        </div>
        <div className="anim-blur-in flex-1 overflow-y-auto">
          {groups === null && (
            <div className="px-3 py-3">
              <SkeletonLines rows={6} />
            </div>
          )}
          {loadError !== null && (
            <ErrorHint error={loadError} onRetry={() => void load()} onDismiss={() => setLoadError(null)} />
          )}
          {!loadError && groups !== null && groups.length === 0 && (
            <div className="px-3 py-4 text-xs text-ink-400">{t("groups.empty")}</div>
          )}
          {(groups ?? []).map((g) => (
            <div
              key={g.group}
              data-testid="group-row"
              onClick={() => {
                // Clicking the already-selected group re-pulls the detail:
                // membership/offsets are live data that change under you
                // (rebalance, commits), so a re-click must refresh.
                if (selected === g.group) void loadDetail(g.group);
                else setSelected(g.group);
              }}
              onContextMenu={(e) =>
                openCtx(e, [
                  // The list row opens the group detail. A "重置 Offset"
                  // item here was a LIE: its action only selected the
                  // group, so nothing reset. Real reset entries live in
                  // the detail's offsets table (per-partition, with the
                  // DryRun preview) — reachable via 组详情.
                  {
                    label: selected === g.group ? t("ctx.reloadDetail") : t("groups.detail"),
                    onSelect: () => (selected === g.group ? void loadDetail(g.group) : setSelected(g.group)),
                  },
                  {
                    label: t("ctx.deleteGroup"),
                    icon: <Trash2 size={13} />,
                    danger: true,
                    separatorBefore: true,
                    onSelect: () => {
                      void confirmDialog({ message: t("groups.deleteConfirm", g.group), danger: true }).then((ok) => {
                        if (!ok) return;
                        void adminApi
                          .deleteGroup(connectionId, g.group)
                          .then(() => {
                            toast.show(t("groups.deleteOk", g.group), "ok");
                            void load();
                          })
                          .catch((e2) => toast.show(friendlyError(e2), "error"));
                      });
                    },
                  },
                ])
              }
              className={`cursor-pointer px-3 py-1.5 text-xs ${
                selected === g.group ? "bg-accent-muted text-ink-100" : "text-ink-200 hover:bg-ink-800"
              }`}
            >
              <div className="flex items-center gap-1.5">
                <span className="truncate font-mono" title={g.group}>
                  {g.group}
                </span>
                {g.type === "streams" && (
                  <span
                    className="flex-none rounded bg-accent-muted px-1 py-0.5 text-10 text-accent"
                    title={t("groups.badgeStreams")}
                  >
                    S
                  </span>
                )}
              </div>
              <div className="text-10 text-ink-400">
                {g.state} · {g.members} members · lag {formatNumber(g.totalLag)}
              </div>
            </div>
          ))}
        </div>
      </div>

      {ctxMenu}
      <div className="min-w-0 flex-1 overflow-auto">
        {detail ? (
          <div className="flex h-full flex-col">
            <div className="flex items-center gap-2 border-b border-ink-700 bg-ink-900 px-3 py-2">
              <span className="text-xs font-medium">
                {t("groups.detail")}: <span className="font-mono">{detail.group}</span>
              </span>
              <span className="rounded bg-ink-800 px-1.5 py-0.5 text-11 text-ink-300">{detail.state}</span>
              <div className="flex-1" />
              <button className="btn btn-danger" onClick={() => setResetting(detail.group)}>
                {t("groups.reset")}
              </button>
              <button
                className="btn btn-danger"
                onClick={() => {
                  void confirmDialog({ message: t("groups.deleteConfirm", detail.group), danger: true }).then((ok) => {
                    if (!ok) return;
                    void adminApi
                    .deleteGroup(connectionId, detail.group)
                    .then(() => {
                      toast.show(t("groups.deleteOk", detail.group), "ok");
                      setSelected(null);
                      setDetail(null);
                      void load();
                    })
                    .catch((e) => toast.show(friendlyError(e), "error"));
                  });
                }}
              >
                {t("groups.delete")}
              </button>
            </div>

            <div className="flex items-center gap-1.5 border-b border-ink-700 bg-ink-900 px-2 py-1.5">
              <button
                className={`btn !px-3 ${detailTab === "offsets" ? "btn-accent" : ""}`}
                onClick={() => setDetailTab("offsets")}
              >
                {t("groups.tabOffsets")} ({detail.offsets.length})
              </button>
              <button
                className={`btn !px-3 ${detailTab === "members" ? "btn-accent" : ""}`}
                onClick={() => setDetailTab("members")}
              >
                {t("groups.tabMembers")} ({detail.members.length})
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              {detailTab === "members" ? (
                <table className="table-fixed w-full border-collapse text-xs">
                  <colgroup>
                    <col className="w-80" />
                    <col className="w-40" />
                    <col className="w-44" />
                    <col />
                  </colgroup>
                  <thead>
                    <tr>
                      <th className="table-head px-2 py-1.5 text-left">{t("groups.colMemberId")}</th>
                      <th className="table-head px-2 py-1.5 text-left">{t("groups.colClientId")}</th>
                      <th className="table-head px-2 py-1.5 text-left">{t("groups.colHost")}</th>
                      <th className="table-head px-2 py-1.5 text-left">{t("groups.colAssignment")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.members.map((m) => (
                      <tr
                        key={m.id}
                        className="border-b border-ink-800 hover:bg-ink-850"
                        onContextMenu={(e) =>
                          openCtx(e, [
                            { label: t("ctx.copyMemberId"), onSelect: () => copy(m.id) },
                            { label: t("ctx.copyClientId"), onSelect: () => copy(m.clientId) },
                            { label: t("ctx.copyHost"), onSelect: () => copy(m.host) },
                          ])
                        }
                      >
                        <td className="px-2 py-1.5">
                          <span className="block truncate font-mono text-ink-200" title={m.id}>
                            {m.id || "∅"}
                          </span>
                        </td>
                        <td className="px-2 py-1.5 font-mono text-ink-100">{m.clientId || "∅"}</td>
                        <td className="px-2 py-1.5 font-mono text-ink-300">{m.host || "∅"}</td>
                        <td className="px-2 py-1.5">
                          {m.assignment.length === 0 ? (
                            <span className="text-ink-400">∅</span>
                          ) : (
                            <div className="flex flex-wrap gap-1">
                              {m.assignment.map((a) => (
                                <span key={a} className="rounded bg-ink-800 px-1.5 py-0.5 font-mono text-10 text-ink-200">
                                  {a}
                                </span>
                              ))}
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                    {detail.members.length === 0 && (
                      <tr>
                        <td colSpan={4} className="px-3 py-6 text-center text-xs text-ink-400">∅</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              ) : (
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr>
                    <th className="table-head px-2 py-1.5">{t("groups.colTopic")}</th>
                    <th className="table-head px-2 py-1.5">{t("groups.colPartition")}</th>
                    <th className="table-head px-2 py-1.5">{t("groups.colCommitted")}</th>
                    <th className="table-head px-2 py-1.5">{t("groups.colLogEnd")}</th>
                    <th className="table-head px-2 py-1.5">{t("groups.colLag")}</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.offsets.map((o) => (
                    <tr
                  onContextMenu={(e) =>
                    openCtx(e, [
                      {
                        label: t("groups.editPartitionOffset"),
                        icon: <Pencil size={13} />,
                        onSelect: () => setEditingOffset({ topic: o.topic, partition: o.partition, committed: o.committed }),
                      },
                    ])
                  } key={`${o.topic}-${o.partition}`} className="border-b border-ink-800 hover:bg-ink-850">
                      <td className="px-2 py-1 font-mono">{o.topic}</td>
                      <td className="px-2 py-1 font-mono text-ink-300">{o.partition}</td>
                      <td className="px-2 py-1 font-mono text-ink-300">
                        {o.committed < 0 ? "∅" : formatNumber(o.committed)}
                      </td>
                      <td className="px-2 py-1 font-mono text-ink-300">{formatNumber(o.logEnd)}</td>
                      <td
                        className={`px-2 py-1 font-mono ${
                          o.lag > 1000 ? "text-warn" : "text-ink-300"
                        }`}
                      >
                        {formatNumber(o.lag)}
                      </td>
                    </tr>
                  ))}
                  {detail.offsets.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-3 py-6 text-center text-xs text-ink-400">
                        {t("groups.empty")}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
              )}
            </div>

            {resetting && (
              <ResetOffsetDialog
                connectionId={connectionId}
                group={resetting}
                topics={[...new Set(detail.offsets.map((o) => o.topic))]}
                onClose={() => setResetting(null)}
                onApplied={() => {
                  if (selected) void loadDetail(selected);
                }}
              />
            )}

            {editingOffset && (
              <ResetOffsetDialog
                connectionId={connectionId}
                group={detail.group}
                topics={[editingOffset.topic]}
                initialMode="absolute"
                initialPartition={editingOffset.partition}
                initialAbsolute={editingOffset.committed}
                warning={detail.state !== "Empty" ? t("groups.resetActiveWarn") : undefined}
                onClose={() => setEditingOffset(null)}
                onApplied={() => {
                  if (selected) void loadDetail(selected);
                }}
              />
            )}
          </div>
        ) : (
          <EmptyState icon={<Users size={20} />} title={t("groups.tab")} desc={t("groups.pickHint")} />
        )}
      </div>
    </div>
  );
}
