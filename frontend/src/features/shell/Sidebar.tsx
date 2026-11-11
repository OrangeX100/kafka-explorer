import { Fragment, useEffect, useState } from "react";
import {
  Cable,
  ChevronsLeft,
  Copy,
  Download,
  FileCode,
  Pencil,
  Plus,
  Braces,
  PlugZap,
  Server,
  Settings as SettingsIcon,
  Star,
  Trash2,
  Unplug,
  Upload,
} from "lucide-react";
import { useConnections } from "../../state/stores.js";
import { useWorkspace } from "../../state/workspace.js";
import { connectionsApi, systemApi } from "../../shared/api.js";
import { useCopy } from "../../shared/useCopy.js";
import { useContextMenu } from "../common/ContextMenu.js";
import { useToast } from "../../state/stores.js";
import { t } from "../../shared/i18n.js";
import { confirmDialog } from "../common/ConfirmDialog.js";
import { friendlyError } from "../../shared/api.js";
import { ThemeToggle } from "./ThemeToggle.js";
import { CloneDialog } from "../connections/ConnectionDialog.js";
import type { Connection } from "../../shared/contracts.js";

export type TopView = "clusters" | "registries" | "connect" | "ksqldb" | "settings";

interface SidebarProps {
  onAddConnection: () => void;
  onEditConnection: (id: string) => void;
  topView: TopView;
  setTopView: (v: TopView) => void;
}

// Sidebar = VS Code-style activity bar (icon rail with an active indicator)
// plus a context column that only the clusters view fills. Rail buttons are
// icon+tooltip: no text squeezing, ever. Opening a connection auto-collapses
// the list (three-pane -> two-pane); the rail's clusters button toggles it
// back, and « in the list header collapses explicitly.
export function Sidebar({ onAddConnection, onEditConnection, topView, setTopView }: SidebarProps) {
  const { list, loading, refresh } = useConnections();
  const [query, setQuery] = useState("");
  // Single click = select (VS Code file-tree semantics); double click opens.
  // selectedId is view-local: it highlights the row without opening a session.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { activeId, open, listOpen, setListOpen, pruneTabs, tabs, closeTab } = useWorkspace();
  const activeConnectionId = activeId; // rail/« 逻辑沿用旧名，避免散点改名
  // A connection is "connected" while its tab is open (the pooled client
  // lives for the tab's lifetime; closing the tab drops it).
  const connected = (id: string) => tabs.some((t) => t.connectionId === id);
  const health = useWorkspace((s) => s.health);
  const setHealth = useWorkspace((s) => s.setHealth);

  // Liveness probe for every open tab: the green dot must mean "broker
  // actually reachable", not just "session object exists". Probes once when
  // the tab set changes and then every 30s; failures flip the dot red.
  useEffect(() => {
    if (tabs.length === 0) return;
    let alive = true;
    const probe = async () => {
      for (const t of useWorkspace.getState().tabs) {
        if (!alive) return;
        try {
          await connectionsApi.ping(t.connectionId);
          if (alive) setHealth(t.connectionId, "ok");
        } catch {
          if (alive) setHealth(t.connectionId, "fail");
        }
      }
    };
    void probe();
    const timer = setInterval(probe, 30_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [tabs.length, setHealth]);
  const copy = useCopy();
  // Clone opens a name dialog FIRST — nothing is created until confirmed
  // (the old flow cloned instantly, so cancel in the editor left the clone).
  const [cloneSource, setCloneSource] = useState<Connection | null>(null);
  // Import/export : JSON file via native
  // dialogs. Passwords never travel in the file — the import report lists
  // SASL entries that need one typed in afterwards.
  const exportConnections = async () => {
    try {
      const path = await connectionsApi.exportConnections();
      if (path) toast.show(t("conn.exportOk"), "ok");
    } catch (err) {
      toast.show(friendlyError(err), "error");
    }
  };
  const importConnections = async () => {
    try {
      const path = await systemApi.pickOpenFile(t("conn.importPick"), "*.json");
      if (!path) return;
      const r = await connectionsApi.importConnections(path);
      await refresh();
      if (r.needPassword && r.needPassword.length > 0) {
        toast.show(t("conn.importNeedPw", r.imported, r.needPassword.length), "info");
      } else {
        toast.show(t("conn.importOk", r.imported), "ok");
      }
    } catch (err) {
      toast.show(friendlyError(err), "error");
    }
  };
  const togglePin = async (id: string, pinned: boolean) => {
    try {
      await connectionsApi.setPinned(id, pinned);
      await refresh();
    } catch (err) {
      toast.show(friendlyError(err), "error");
    }
  };
  // Double-click flow: create the tab, probe the broker immediately, and
  // collapse the list ONLY when a NEW connection verifies reachable. A
  // failed probe keeps the list open (red dot + workspace error visible) so
  // fixing the config takes zero extra clicks. Multi-open never auto-collapses.
  // Switching to an ALREADY-open tab (single or double click) must never
  // collapse — with one connection the old check collapsed the whole sidebar
  // on every re-open, which read as the list flickering away.
  const openFlow = async (conn: { id: string; name: string }) => {
    const existed = useWorkspace.getState().tabs.some((t) => t.connectionId === conn.id);
    open(conn.id, conn.name);
    if (existed) return;
    const first = () => useWorkspace.getState().tabs.length === 1;
    try {
      await connectionsApi.ping(conn.id);
      setHealth(conn.id, "ok");
      if (first()) setListOpen(false);
    } catch {
      setHealth(conn.id, "fail");
    }
  };
  const disconnect = (id: string) => {
    // 断开连接 = end the session: close the tab and drop the pooled client.
    void connectionsApi.disconnect(id).catch((err) => toast.show(friendlyError(err), "error"));
    closeTab(id);
    toast.show(t("conn.disconnectOk"), "ok");
  };
  const toast = useToast();
  const { open: openCtx, menu: ctxMenu } = useContextMenu();

  // Rail clusters button: navigates to the clusters view — and once a
  // connection is open (two-pane mode) it toggles the connection list.
  const onClustersClick = () => {
    if (topView === "clusters" && activeConnectionId) {
      setListOpen(!listOpen);
    } else {
      setTopView("clusters");
    }
  };

  const remove = async (id: string, name: string) => {
    if (!(await confirmDialog({ message: t("conn.deleteConfirm", name), danger: true }))) return;
    try {
      await connectionsApi.remove(id);
      await refresh();
      // The connection is gone: its tab (if any) must go with it.
      pruneTabs(useConnections.getState().list.map((c) => c.id));
      toast.show(t("common.deleted"), "ok");
    } catch (err) {
      toast.show(friendlyError(err), "error");
    }
  };

  const navItems: { view: TopView; icon: React.ReactNode; title: string; onClick?: () => void }[] = [
    { view: "clusters", icon: <Cable size={17} />, title: t("sidebar.connections"), onClick: onClustersClick },
    { view: "registries", icon: <FileCode size={17} />, title: t("sidebar.registries") },
    { view: "connect", icon: <PlugZap size={17} />, title: t("sidebar.connect") },
    { view: "ksqldb", icon: <Braces size={17} />, title: t("sidebar.ksqldb") },
  ];

  // The list hides when collapsed; with no active connection it always
  // shows (nothing to collapse into). Width animates so the content
  // reflows instead of jumping.
  const showList = topView === "clusters" && (listOpen || !activeConnectionId);

  return (
    <div className="flex h-full">
      {/* activity rail */}
      <nav className="flex w-12 flex-none flex-col items-center border-r border-ink-700 bg-ink-900 py-2">
        {navItems.map((n) => {
          const active = topView === n.view;
          return (
            <button
              key={n.view}
              data-tip={n.title}
              onClick={() => (n.onClick ? n.onClick() : setTopView(n.view))}
              className={`relative mb-1 flex h-10 w-10 items-center justify-center rounded transition-colors ${
                active ? "bg-accent-muted text-accent" : "text-ink-300 hover:bg-ink-800 hover:text-ink-100"
              }`}
            >
              {active && <span className="absolute left-0 top-2 bottom-2 w-0.5 rounded-full bg-accent" />}
              {n.icon}
            </button>
          );
        })}
        <div className="flex-1" />
        <button
          data-tip={t("settings.title")}
          onClick={() => setTopView("settings")}
          className={`relative mb-1 flex h-10 w-10 items-center justify-center rounded transition-colors ${
            topView === "settings" ? "bg-accent-muted text-accent" : "text-ink-300 hover:bg-ink-800 hover:text-ink-100"
          }`}
        >
          {topView === "settings" && (
            <span className="absolute left-0 top-2 bottom-2 w-0.5 rounded-full bg-accent" />
          )}
          <SettingsIcon size={17} />
        </button>
        <ThemeToggle />
      </nav>

      {/* context column: only the clusters view fills it; auto-collapsed
          once a connection is open (width animates, content reflows) */}
      {topView === "clusters" && (
        <aside
          className={`flex flex-none overflow-hidden bg-ink-900 transition-[width] duration-200 ${
            showList ? "w-60 border-r border-ink-700" : "w-0"
          }`}
        >
          <div className="flex w-60 flex-col">
          <div className="flex items-center justify-between px-3 py-2">
            <span className="text-10 font-semibold uppercase tracking-wide text-ink-300">
              {t("sidebar.connections")}
            </span>
            <div className="flex items-center gap-1">
              {activeConnectionId && (
                <button
                  onClick={() => setListOpen(false)}
                  className="flex h-5 w-5 items-center justify-center rounded text-ink-300 transition-colors hover:bg-ink-700 hover:text-ink-100"
                >
                  <ChevronsLeft size={13} />
                </button>
              )}
              <button className="btn !px-1.5 !py-1" title={t("conn.importTitle")} onClick={() => void importConnections()}>
                <Upload size={13} />
              </button>
              <button className="btn !px-1.5 !py-1" title={t("conn.exportTitle")} onClick={() => void exportConnections()}>
                <Download size={13} />
              </button>
              <button
                className="btn btn-accent !px-1.5 !py-1"
                title={t("sidebar.addConnection")}
                onClick={onAddConnection}
              >
                <Plus size={14} />
              </button>
            </div>
          </div>

          <div className="px-3 pb-1.5">
            <input
              className="field !py-1 text-xs"
              placeholder={t("sidebar.searchConnection")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setQuery("");
              }}
            />
          </div>
          <div className="flex-1 overflow-y-auto py-1">
            {loading && <div className="px-3 py-2 text-xs text-ink-400">{t("common.loading")}</div>}
            {(() => {
              const q = query.trim().toLowerCase();
              const filtered = q
                ? list.filter((c) => c.name.toLowerCase().includes(q) || c.bootstrap.toLowerCase().includes(q))
                : list;
              if (filtered.length === 0) {
                return (
                  <div className="px-3 py-4 text-xs text-ink-400">
                    {list.length === 0 ? t("sidebar.empty") : t("sidebar.noMatch")}
                  </div>
                );
              }
              return (
                <Fragment key="f">
                {filtered.map((conn) => {
              const active = conn.id === activeConnectionId;
              return (
                <div
                  key={conn.id}
                  className={`group relative flex items-center gap-2 px-3 py-1.5 cursor-pointer text-xs transition-colors ${
                    active
                      ? "bg-accent-muted text-ink-100"
                      : selectedId === conn.id
                        ? "bg-ink-800 text-ink-100"
                        : "text-ink-200 hover:bg-ink-800"
                  }`}
                  onContextMenu={(e) =>
                    openCtx(e, [
                      { label: t("conn.open"), icon: <Server size={13} />, onSelect: () => open(conn.id, conn.name) },
                      {
                        label: t("conn.disconnect"),
                        icon: <Unplug size={13} />,
                        disabled: !connected(conn.id),
                        onSelect: () => void disconnect(conn.id),
                      },
                      {
                        label: conn.pinned ? t("conn.unpin") : t("conn.pin"),
                        icon: <Star size={13} />,
                        onSelect: () => void togglePin(conn.id, !conn.pinned),
                      },
                      { label: t("conn.clone"), icon: <Copy size={13} />, separatorBefore: true, onSelect: () => setCloneSource(conn) },
                      { label: t("conn.edit"), icon: <Pencil size={13} />, onSelect: () => onEditConnection(conn.id) },
                      { label: t("conn.copyAddress"), icon: <Copy size={13} />, separatorBefore: true, onSelect: () => copy(conn.bootstrap) },
                      {
                        label: t("conn.delete"),
                        icon: <Trash2 size={13} />,
                        danger: true,
                        separatorBefore: true,
                        onSelect: () => void remove(conn.id, conn.name),
                      },
                    ])
                  }
                  onClick={() => {
                    if (connected(conn.id)) {
                      // Opened cluster: single click switches to its tab —
                      // the row IS a session entry once the tab exists.
                      open(conn.id, conn.name);
                      setSelectedId(conn.id);
                    } else {
                      setSelectedId(conn.id);
                    }
                  }}
                  onDoubleClick={() => void openFlow(conn)}
                  title={`${connected(conn.id) ? t("conn.rowHintOpen") : t("conn.rowHint")} · ${conn.bootstrap}`}
                >
                  {selectedId === conn.id && !active && (
                    <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-accent" aria-hidden="true" />
                  )}
                  {(() => {
                    const open = connected(conn.id);
                    const h = health[conn.id];
                    const cls = !open ? "bg-ink-500" : h === "fail" ? "bg-danger" : h === "ok" ? "bg-ok" : "bg-ink-500 animate-pulse";
                    const tip = !open
                      ? t("conn.statusDisconnected")
                      : h === "fail"
                        ? t("conn.statusFailed")
                        : h === "ok"
                          ? t("conn.statusConnected")
                          : t("conn.statusProbing");
                    return <span className={`h-1.5 w-1.5 flex-none rounded-full ${cls}`} title={tip} />;
                  })()}
                  <Server size={13} className={active ? "text-accent" : "text-ink-400"} />
                  <span className="flex-1 flex min-w-0 items-center gap-1 truncate">
                    {conn.name}
                    {conn.pinned && <span title={t("conn.pin")}><Star size={11} className="flex-none fill-amber-400 text-amber-400" /></span>}
                  </span>
                  <button
                    className="opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
                    title={t("conn.delete")}
                    onClick={(e) => {
                      e.stopPropagation();
                      void remove(conn.id, conn.name);
                    }}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              );
                })}
                </Fragment>
              );
            })()}
          </div>

          <div className="flex items-center border-t border-ink-700 px-3 py-2 text-11 text-ink-400">
            <span>
              {t("app.title")} · {list.length}
            </span>
          </div>
          {ctxMenu}
          </div>
        </aside>
      )}
      {cloneSource && (
        <CloneDialog
          source={cloneSource}
          onClose={() => setCloneSource(null)}
          // CloneDialog can already rename before cloning — no editor popup
          // afterwards (it used to stack over the list and block deletes).
          onCloned={() => setCloneSource(null)}
        />
      )}
    </div>
  );
}

