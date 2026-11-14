import { useCallback, useEffect, useRef, useState } from "react";
import { Pencil, RefreshCw, Trash2, Users } from "lucide-react";
import { groupsApi, adminApi, classifyError } from "../../shared/api.js";
import { useToast } from "../../state/stores.js";
import { t } from "../../shared/i18n.js";
import { confirmDialog } from "../common/ConfirmDialog.js";
import { formatNumber } from "../../shared/format.js";
import { SkeletonLines } from "../common/Skeleton.js";
import { EmptyState } from "../common/EmptyState.js";
import { useContextMenu } from "../common/ContextMenu.js";
import { useCopy } from "../../shared/useCopy.js";
import { ShareOffsetDialog, ClearShareOffsetsDialog } from "./ShareGroupDialogs.js";
import type { ShareGroupDetail, ShareGroupSummary } from "../../shared/contracts.js";
import { friendlyError } from "../../shared/api.js";
import { ErrorHint } from "../common/ErrorHint.js";

// ShareGroupsView: KIP-932 share groups (Kafka 4.2+, broker needs
// group.share.enable=true). Same two-pane shape as GroupsView; the detail
// shows the share start offsets (records at/before them are delivered).
export function ShareGroupsView({ connectionId }: { connectionId: string }) {
  const [groups, setGroups] = useState<ShareGroupSummary[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [selected, setSelected] = useState<string | null>(null);
  // Stale-response guard: rapid selection switches must not let an older
  // detail response overwrite the newer one (045 batch-3 round).
  const requestSeq = useRef(0);
  const [detail, setDetail] = useState<ShareGroupDetail | null>(null);
  const [detailTab, setDetailTab] = useState<"offsets" | "members">("offsets");
  const [editingOffset, setEditingOffset] = useState<{ topic: string; partition: number; startOffset: number } | null>(null);
  const [clearing, setClearing] = useState(false);
  // (s) => s.show: stable action identity — a whole-store useToast() here
  // rebuilt loadDetail on every toast and looped refetch+toast forever.
  const toast = { show: useToast((s) => s.show) };
  const { open: openCtx, menu: ctxMenu } = useContextMenu();
  const copy = useCopy();

  const load = useCallback(async () => {
    setGroups(null);
    setLoadError(null); // a stale failure banner must not outlive success
    try {
      setGroups((await groupsApi.listShareGroups(connectionId)) ?? []);
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
      const seq = ++requestSeq.current;
      try {
        const d = await groupsApi.shareGroupDetail(connectionId, group);
        if (seq !== requestSeq.current) return; // a newer selection won
        setDetail(d);
      } catch (err) {
        if (seq === requestSeq.current) toast.show(friendlyError(err), "error");
      }
    },
    [connectionId, toast]
  );

  useEffect(() => {
    if (selected) void loadDetail(selected);
  }, [selected, loadDetail]);

  // Backend wraps UNSUPPORTED_VERSION with this guidance sentence; match on
  // it to swap the whole pane for a how-to-fix panel instead of raw error.
  const unsupported = classifyError(loadError).key === "error.shareUnsupported";

  const deleteGroup = (group: string) => {
    void confirmDialog({ message: t("share.deleteConfirm", group), danger: true }).then((ok) => {
      if (!ok) return;
      void adminApi
        .deleteGroup(connectionId, group)
        .then(() => {
          toast.show(t("groups.deleteOk", group), "ok");
          setSelected(null);
          setDetail(null);
          void load();
        })
        .catch((e) => toast.show(friendlyError(e), "error"));
    });
  };

  const topicsOf = detail ? [...new Set(detail.offsets.map((o) => o.topic))] : [];

  return (
    <div className="flex h-full">
      <div className="flex w-72 min-w-48 flex-col border-r border-ink-700 bg-ink-900">
        <div className="flex items-center border-b border-ink-700 px-2 py-1.5">
          <button className="btn" title={t("topics.refresh")} onClick={() => void load()}>
            <RefreshCw size={13} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {groups === null && (
            <div className="px-3 py-3">
              <SkeletonLines rows={6} />
            </div>
          )}
          {unsupported && (
            <div className="px-3 py-4 text-xs text-warn">{t("share.unsupported")}</div>
          )}
          {loadError !== null && !unsupported && (
            <div className="px-3 py-4">
              <ErrorHint error={loadError} onRetry={() => void load()} onDismiss={() => setLoadError(null)} />
            </div>
          )}
          {!loadError && groups !== null && groups.length === 0 && (
            <div className="px-3 py-4 text-xs text-ink-400">{t("share.empty")}</div>
          )}
          {(groups ?? []).map((g) => (
            <div
              key={g.group}
              onClick={() => {
                // Re-click refreshes: membership and start offsets are live
                // data that move under you (heartbeats, acks).
                if (selected === g.group) void loadDetail(g.group);
                else setSelected(g.group);
              }}
              onContextMenu={(e) =>
                openCtx(e, [
                  { label: t("groups.detail"), onSelect: () => setSelected(g.group) },
                  {
                    label: t("share.clearOffsets"),
                    separatorBefore: true,
                    onSelect: () => {
                      setSelected(g.group);
                      setClearing(true);
                    },
                  },
                  {
                    label: t("ctx.deleteGroup"),
                    icon: <Trash2 size={13} />,
                    danger: true,
                    separatorBefore: true,
                    onSelect: () => deleteGroup(g.group),
                  },
                ])
              }
              className={`cursor-pointer px-3 py-1.5 text-xs ${
                selected === g.group ? "bg-accent-muted text-ink-100" : "text-ink-200 hover:bg-ink-800"
              }`}
            >
              <div className="truncate font-mono" title={g.group}>
                {g.group}
              </div>
              <div className="text-10 text-ink-400">
                {g.state} · {g.members} members
                {g.subscribed.length > 0 && <> · {g.subscribed.length} topics</>}
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
              {detail.assignor && (
                <span className="rounded bg-ink-800 px-1.5 py-0.5 text-11 text-ink-300">
                  {t("share.assignor")}: {detail.assignor}
                </span>
              )}
              <div className="flex-1" />
              <button className="btn btn-danger" onClick={() => setClearing(true)}>
                {t("share.clearOffsets")}
              </button>
              <button className="btn btn-danger" onClick={() => deleteGroup(detail.group)}>
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
                      <th className="table-head px-2 py-1.5">{t("share.colStartOffset")}</th>
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
                              label: t("share.editStartOffset"),
                              icon: <Pencil size={13} />,
                              onSelect: () =>
                                setEditingOffset({ topic: o.topic, partition: o.partition, startOffset: o.startOffset }),
                            },
                          ])
                        }
                        key={`${o.topic}-${o.partition}`}
                        className="border-b border-ink-800 hover:bg-ink-850"
                      >
                        <td className="px-2 py-1 font-mono">{o.topic}</td>
                        <td className="px-2 py-1 font-mono text-ink-300">{o.partition}</td>
                        <td className="px-2 py-1 font-mono text-ink-300">{formatNumber(o.startOffset)}</td>
                        <td className="px-2 py-1 font-mono text-ink-300">{formatNumber(o.logEnd)}</td>
                        <td
                          className={`px-2 py-1 font-mono ${
                            o.lag < 0 ? "text-ink-400" : o.lag > 1000 ? "text-warn" : "text-ink-300"
                          }`}
                        >
                          {o.lag < 0 ? "∅" : formatNumber(o.lag)}
                        </td>
                      </tr>
                    ))}
                    {detail.offsets.length === 0 && (
                      <tr>
                        <td colSpan={5} className="px-3 py-6 text-center text-xs text-ink-400">
                          {t("share.offsetsEmpty")}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              )}
            </div>

            {editingOffset && (
              <ShareOffsetDialog
                connectionId={connectionId}
                group={detail.group}
                target={editingOffset}
                warning={detail.state !== "Empty" ? t("share.activeWarn") : undefined}
                onClose={() => setEditingOffset(null)}
                onApplied={() => {
                  if (selected) void loadDetail(selected);
                }}
              />
            )}

            {clearing && (
              <ClearShareOffsetsDialog
                connectionId={connectionId}
                group={detail.group}
                topics={topicsOf}
                onClose={() => setClearing(false)}
                onApplied={() => {
                  if (selected) void loadDetail(selected);
                }}
              />
            )}
          </div>
        ) : (
          <EmptyState
            icon={<Users size={20} />}
            title={t("sidebar.share")}
            desc={t("share.hint")}
          />
        )}
      </div>
    </div>
  );
}
