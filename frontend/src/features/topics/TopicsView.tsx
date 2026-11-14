import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, RefreshCw } from "lucide-react";
import { topicsApi, friendlyError } from "../../shared/api.js";
import { useToast } from "../../state/stores.js";
import { t } from "../../shared/i18n.js";
import { formatNumber } from "../../shared/format.js";
import { SkeletonLines } from "../common/Skeleton.js";
import { EmptyState } from "../common/EmptyState.js";
import { Copy, ListTree, Settings2, Trash2 } from "lucide-react";
import type { TopicSummary } from "../../shared/contracts.js";
import { MessagesView } from "./MessagesView.js";
import { CreateTopicDialog } from "./CreateTopicDialog.js";
import { useContextMenu } from "../common/ContextMenu.js";
import { confirmDialog } from "../common/ConfirmDialog.js";
import { ErrorHint } from "../common/ErrorHint.js";
import { Select } from "../common/controls.js";
import { isEcosystemTopic, isProtectedTopic } from "../../shared/kafkaInternal.js";
import { useCopy } from "../../shared/useCopy.js";

export function TopicsView({ connectionId }: { connectionId: string }) {
  const [topics, setTopics] = useState<TopicSummary[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [selected, setSelected] = useState<string | null>(null);
  // Which surface the detail pane shows for the selected topic — lifted
  // here so the list context menu can jump straight to messages/config.
  const [topicView, setTopicView] = useState<"messages" | "config" | "visualization">("messages");
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState("");
  // Search-result paging: 50 per page by default, user-selectable within a
  // sane ceiling (25–200) — a few hundred rows render fine, 10k would not.
  const [pageSize, setPageSize] = useState(50);
  const [page, setPage] = useState(0);
  const toast = useToast();
  const copy = useCopy();
  const { open: openCtx, menu: ctxMenu } = useContextMenu();

  const load = useCallback(async () => {
    setTopics(null);
    // A previous failure's banner must not outlive a successful refresh.
    setLoadError(null);
    try {
      setTopics((await topicsApi.list(connectionId)) ?? []);
    } catch (err) {
      setTopics([]);
      setLoadError(err);
    }
  }, [connectionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const remove = async (topic: string) => {
    // Protected topics (Kafka __-internal plus ecosystem-managed like
    // _schemas) carry cluster/service-critical state — deleting one wipes
    // consumer offsets or the whole schema registry. Blocked in the UI;
    // the backend refuses the call too, so this toast is the friendly face.
    if (isProtectedTopic(topic)) {
      toast.show(
        isEcosystemTopic(topic)
          ? t("topics.ecosystemDeleteBlocked", topic)
          : t("topics.internalDeleteBlocked", topic),
        "error",
      );
      return;
    }
    if (!(await confirmDialog({ message: t("topics.deleteConfirm", topic), danger: true }))) return;
    try {
      await topicsApi.remove(connectionId, topic);
      if (selected === topic) setSelected(null);
      toast.show(t("common.deleted"), "ok");
      await load();
    } catch (err) {
      toast.show(friendlyError(err), "error");
    }
  };

  // Context-menu navigation must be observable even when the topic is
  // already selected: switching only `selected` is a no-op then.
  const openTopic = (name: string, view: "messages" | "config") => {
    setSelected(name);
    setTopicView(view);
  };

  const filtered = (topics ?? []).filter((tp) => tp.name.includes(filter));

  // Page clamp: deletions/refreshes shrink the list while the user sits on
  // a page that no longer exists — slice() then renders an EMPTY list with
  // the pager hidden, a dead-end only escapable by re-filtering (045 round).
  useEffect(() => {
    const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
    if (page >= pageCount) setPage(pageCount - 1);
  }, [filtered.length, pageSize, page]);

  // Ladder timers survive unmounts without a handle: navigating away within
  // 9s fired load() against a switched-away connection (045 batch-3 round).
  const refreshTimers = useRef<number[]>([]);
  useEffect(() => () => {
    refreshTimers.current.forEach((id) => window.clearTimeout(id));
  }, []);

  return (
    <div className="flex h-full">
      {/* Topic list pane */}
      <div className="flex w-72 min-w-48 flex-col border-r border-ink-700 bg-ink-900">
        <div className="flex items-center gap-1.5 border-b border-ink-700 px-2 py-1.5">
          <button className="btn" title={t("topics.refresh")} onClick={() => void load()}>
            <RefreshCw size={13} />
          </button>
          <button className="btn" title={t("topics.create")} onClick={() => setCreating(true)}>
            <Plus size={13} />
          </button>
          <div className="relative flex-1">
            <input
              className="field !py-1 pr-6"
              placeholder="filter…"
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value);
                setPage(0);
              }}
              onKeyDown={(e) => e.key === "Escape" && setFilter("")}
            />
            {filter !== "" && (
              <button
                type="button"
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-ink-400 transition-colors hover:bg-ink-700 hover:text-ink-100"
                title={t("topics.clearFilter")}
                onClick={() => {
                  setFilter("");
                  setPage(0);
                }}
              >
                ✕
              </button>
            )}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {topics === null && (
            <div className="px-3 py-3">
              <SkeletonLines rows={6} />
            </div>
          )}
          {loadError !== null && (
            <ErrorHint error={loadError} onRetry={() => void load()} onDismiss={() => setLoadError(null)} />
          )}
          {!loadError && topics !== null && topics.length === 0 && (
            <div className="px-3 py-4 text-xs text-ink-400">{t("topics.empty")}</div>
          )}
          {filtered
            .slice(page * pageSize, page * pageSize + pageSize)
            .map((tp) => (
            <div
              key={tp.name}
              onClick={() => setSelected(tp.name)}
              onContextMenu={(e) =>
                openCtx(e, [
                  { label: t("ctx.viewMessages"), icon: <ListTree size={13} />, onSelect: () => openTopic(tp.name, "messages") },
                  { label: t("ctx.viewConfig"), icon: <Settings2 size={13} />, onSelect: () => openTopic(tp.name, "config") },
                  { label: t("ctx.copyName"), icon: <Copy size={13} />, onSelect: () => copy(tp.name) },
                  { label: t("ctx.deleteTopic"), icon: <Trash2 size={13} />, danger: true, separatorBefore: true, onSelect: () => void remove(tp.name) },
                ])
              }
              className={`group cursor-pointer px-3 py-1.5 text-xs ${
                selected === tp.name ? "bg-accent-muted text-ink-100" : "text-ink-200 hover:bg-ink-800"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-mono" title={tp.name}>
                  {tp.internal && (
                    <span
                      className="mr-1 flex-none rounded bg-warn/20 px-1 text-10 font-medium text-warn"
                      title={t(isEcosystemTopic(tp.name) ? "topics.ecosystemHint" : "topics.internalHint")}
                    >
                      {t(isEcosystemTopic(tp.name) ? "topics.ecosystemBadge" : "topics.internalBadge")}
                    </span>
                  )}
                  {tp.name}
                </span>
                <button
                  className="text-ink-400 opacity-0 hover:text-danger group-hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    void remove(tp.name);
                  }}
                >
                  ✕
                </button>
              </div>
              <div className="text-10 text-ink-400">
                {tp.partitions}P · RF{tp.replicationFactor} · {formatNumber(tp.messageCount)} msg
              </div>
            </div>
          ))}
            {filtered.length > pageSize && (
              <div className="flex items-center justify-between gap-2 border-t border-ink-800 px-3 py-2 text-10 text-ink-400">
                <span>
                  {page * pageSize + 1}–{Math.min((page + 1) * pageSize, filtered.length)} / {filtered.length}
                </span>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    className="rounded px-1.5 py-0.5 transition-colors hover:bg-ink-700 hover:text-ink-100 disabled:opacity-40"
                    disabled={page === 0}
                    onClick={() => setPage(page - 1)}
                  >
                    ‹
                  </button>
                  <span className="font-mono">
                    {page + 1}/{Math.max(1, Math.ceil(filtered.length / pageSize))}
                  </span>
                  <button
                    type="button"
                    className="rounded px-1.5 py-0.5 transition-colors hover:bg-ink-700 hover:text-ink-100 disabled:opacity-40"
                    disabled={(page + 1) * pageSize >= filtered.length}
                    onClick={() => setPage(page + 1)}
                  >
                    ›
                  </button>
                                    <Select
                    className="!w-20"
                    value={String(pageSize)}
                    options={[25, 50, 100, 200].map((n) => ({ value: String(n), label: String(n) }))}
                    onChange={(v) => {
                      setPageSize(Number(v));
                      setPage(0);
                    }}
                  />
                </div>
              </div>
            )}
        </div>
      </div>

      {/* Detail pane */}
      <div className="min-w-0 flex-1">
        {selected ? (
          <MessagesView
            key={selected}
            connectionId={connectionId}
            topic={selected}
            view={topicView}
            onViewChange={setTopicView}
          />
        ) : (
          <EmptyState
            icon={<ListTree size={20} />}
            title={t("topics.tab")}
            desc={t("topic.pick")}
          />
        )}
      </div>

      {ctxMenu}
      {creating && (
        <CreateTopicDialog
          connectionId={connectionId}
          onClose={() => setCreating(false)}
          onCreated={() => {
            void load();
            // Broker metadata propagation lags; the backend serves up-to-
            // 10s-old cached metadata, so a single refresh can miss the new
            // topic. Retry on a short ladder until one lands — handles kept
            // so unmount clears them (see refreshTimers above).
            for (const delay of [2000, 5000, 9000]) {
              refreshTimers.current.push(window.setTimeout(() => void load(), delay));
            }
          }}
        />
      )}
    </div>
  );
}
