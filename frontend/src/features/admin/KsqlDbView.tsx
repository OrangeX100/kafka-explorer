import { useCallback, useEffect, useRef, useState } from "react";
import { ksqlDbApi, friendlyError } from "../../shared/api.js";
import { useToast } from "../../state/stores.js";
import { t } from "../../shared/i18n.js";
import { SkeletonLines } from "../common/Skeleton.js";
import { EmptyState } from "../common/EmptyState.js";
import { ErrorHint } from "../common/ErrorHint.js";
import { useContextMenu } from "../common/ContextMenu.js";
import { confirmDialog } from "../common/ConfirmDialog.js";
import { useCopy } from "../../shared/useCopy.js";
import { Trash2, Copy, Plus, Braces, RefreshCw } from "lucide-react";
import type { KsqlDbServer } from "../../shared/contracts-admin.js";
import { KsqlDbServerDialog } from "./KsqlDialogs.js";
import { QueryEditor, CatalogList, QueriesList } from "./KsqlQuery.js";
import { GlidingTabs } from "../common/GlidingTabs.js";

type Tab = "query" | "streams" | "tables" | "queries";

// KsqlDbView: the ksqlDB workspace — server list + query editor with live
// streaming results + streams/tables/persistent-queries browsing.
export function KsqlDbView() {
  const [servers, setServers] = useState<KsqlDbServer[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [tab, setTab] = useState<Tab>("query");
  const toast = { show: useToast((s) => s.show) };

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const list = (await ksqlDbApi.list()) ?? [];
      setServers(list);
      if (list.length > 0) setActiveId((cur) => cur ?? list[0].id);
    } catch (err) {
      setLoadError(err);
      setServers([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const remove = async (s: KsqlDbServer) => {
    if (!(await confirmDialog({ message: t("ksql.deleteConfirm", s.name), danger: true }))) return;
    try {
      await ksqlDbApi.remove(s.id);
      if (activeId === s.id) setActiveId(null);
      toast.show(t("common.deleted"), "ok");
      await load();
    } catch (err) {
      toast.show(friendlyError(err), "error");
    }
  };

  const { open: openCtx, menu: ctxMenu } = useContextMenu();
  const copy = useCopy();
  const active = (servers ?? []).find((s) => s.id === activeId) ?? null;

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-ink-950">
      <div className="flex items-center gap-1.5 border-b border-ink-700 bg-ink-900 px-2 py-1.5">
        <span className="px-1 text-xs font-semibold text-ink-200">ksqlDB</span>
        <div className="flex-1" />
        <button className="btn btn-accent" onClick={() => setCreating(true)}>
          <Plus size={13} /> {t("ksql.addServer")}
        </button>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="w-60 flex-none overflow-y-auto border-r border-ink-700 bg-ink-900 py-1">
          {servers === null && <div className="px-3 py-3"><SkeletonLines rows={3} /></div>}
          {loadError ? (
            <div className="px-2 py-2"><ErrorHint error={loadError} onRetry={() => void load()} compact /></div>
          ) : null}
          {(servers ?? []).map((s) => (
            <div
              key={s.id}
              data-testid="ksqldb-server"
              onContextMenu={(e) =>
                openCtx(e, [
                  { label: t("ctx.openCluster"), onSelect: () => setActiveId(s.id) },
                  { label: t("ctx.copyName"), icon: <Copy size={13} />, onSelect: () => copy(s.name) },
                  { label: t("ctx.copyUrl"), icon: <Copy size={13} />, onSelect: () => copy(s.url) },
                  { label: t("ctx.deleteCluster"), icon: <Trash2 size={13} />, danger: true, separatorBefore: true, onSelect: () => void remove(s) },
                ])
              }
              onClick={() => setActiveId(s.id)}
              className={`cursor-pointer px-3 py-1.5 text-xs ${
                activeId === s.id ? "bg-accent-muted text-ink-100" : "text-ink-200 hover:bg-ink-800"
              }`}
            >
              <div className="truncate">{s.name}</div>
              <div className="truncate font-mono text-10 text-ink-400" title={s.url}>{s.url}</div>
            </div>
          ))}
        </div>
        <div className="min-w-0 flex-1">
          {active === null ? (
            <EmptyState
              icon={<Braces size={20} />}
              title="ksqlDB"
              desc={t("ksql.empty")}
            />
          ) : (
            // key per server: each server owns a fresh panel set (cached
            // catalogs must never leak across servers).
            <KsqlWorkspace key={active.id} server={active} tab={tab} setTab={setTab} onReload={() => void load()} />
          )}
        </div>
        {ctxMenu}
      </div>

      {creating && (
        <KsqlDbServerDialog
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            void load();
          }}
        />
      )}
    </main>
  );
}

function KsqlWorkspace({
  server,
  tab,
  setTab,
  onReload,
}: {
  server: KsqlDbServer;
  tab: Tab;
  setTab: (t: Tab) => void;
  onReload: () => void;
}) {
  const tabs: { key: Tab; label: string }[] = [
    { key: "query", label: t("ksql.tabQuery") },
    { key: "streams", label: t("ksql.tabStreams") },
    { key: "tables", label: t("ksql.tabTables") },
    { key: "queries", label: t("ksql.tabQueries") },
  ];
  // Keep-alive: every VISITED panel stays mounted and only toggles
  // visibility. Conditional unmount/remount was the flicker root cause —
  // each switch refetched and flashed the skeleton. Data, scroll position
  // and the in-progress editor text now survive tab switches.
  const visited = useRef(new Set<Tab>([tab]));
  visited.current.add(tab);
  const panels: { key: Tab; el: React.ReactNode }[] = [
    { key: "query", el: <QueryEditor serverId={server.id} /> },
    { key: "streams", el: <CatalogList serverId={server.id} kind="streams" /> },
    { key: "tables", el: <CatalogList serverId={server.id} kind="tables" /> },
    { key: "queries", el: <QueriesList serverId={server.id} /> },
  ];
  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex items-center gap-1.5 border-b border-ink-700 bg-ink-900 px-2 py-1.5">
        <GlidingTabs
          tabs={tabs.map((tb) => ({ value: tb.key, label: tb.label }))}
          value={tab}
          onChange={(k) => {
            visited.current.add(k as Tab);
            setTab(k as Tab);
          }}
        />
        {/* Discreet refresh lives in the tab-bar row — the bottom button was
            noise; catalog data can still be manually refreshed. */}
        {tab !== "query" && (
          <button
            className="btn !px-1.5 !py-1 text-ink-400 hover:text-ink-100"
            title={t("topics.refresh")}
            onClick={onReload}
          >
            <RefreshCw size={12} />
          </button>
        )}
      </div>
      {panels.map((p) => {
        const isActive = tab === p.key;
        if (!visited.current.has(p.key)) return null; // lazy: fetch on first visit
        return (
          <div
            key={p.key}
            hidden={!isActive}
            data-state={isActive ? "active" : "inactive"}
            className="ksql-panel min-h-0 flex-1 flex-col"
          >
            {p.el}
          </div>
        );
      })}
    </div>
  );
}

