import { Plus, Server, X } from "lucide-react";
import { useWorkspace } from "../../state/workspace.js";
import { t } from "../../shared/i18n.js";
import { useContextMenu } from "../common/ContextMenu.js";

// TabBar: one tab per open cluster (connection-level, not topic-level — a
// tab is a whole cluster workspace whose section/selection state survives
// switching). Middle-click or ✕ closes the tab; the connection itself is
// never deleted from here. The + opens the new-connection dialog. A tab's
// context menu offers close / close others / close all.
export function TabBar({ onAddConnection }: { onAddConnection: () => void }) {
  const tabs = useWorkspace((s) => s.tabs);
  const activeId = useWorkspace((s) => s.activeId);
  const open = useWorkspace((s) => s.open);
  const closeTab = useWorkspace((s) => s.closeTab);
  const closeOthers = useWorkspace((s) => s.closeOthers);
  const closeAll = useWorkspace((s) => s.closeAll);
  const { open: openCtx, menu: ctxMenu } = useContextMenu();

  return (
    <>
      {ctxMenu}
      <div className="flex flex-none items-stretch border-b border-ink-700 bg-ink-900 pl-1 pr-1.5 pt-1">
        <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto">
          {tabs.map((tab) => {
            const active = tab.connectionId === activeId;
            return (
              <div
                key={tab.connectionId}
                onClick={() => open(tab.connectionId, tab.name)}
                onAuxClick={(e) => {
                  if (e.button === 1) {
                    e.preventDefault();
                    closeTab(tab.connectionId);
                  }
                }}
                onContextMenu={(e) =>
                  openCtx(e, [
                    { label: t("sidebar.closeTab"), onSelect: () => closeTab(tab.connectionId) },
                    { label: t("ctx.closeOthers"), disabled: tabs.length <= 1, onSelect: () => closeOthers(tab.connectionId) },
                    { label: t("ctx.closeAll"), separatorBefore: true, onSelect: () => closeAll() },
                  ])
                }
                title={tab.name}
                className={`group relative flex max-w-52 min-w-32 flex-none cursor-pointer items-center gap-1.5 rounded-t px-2.5 py-1.5 text-xs transition-colors ${
                  active ? "bg-ink-950 text-ink-100" : "bg-ink-900 text-ink-300 hover:bg-ink-800 hover:text-ink-200"
                }`}
              >
                {active && <span className="absolute inset-x-1 top-0 h-0.5 rounded-full bg-accent" />}
                <Server size={12} className={active ? "flex-none text-accent" : "flex-none text-ink-500"} />
                <span className="flex-1 truncate">{tab.name}</span>
                <button
                  className="flex h-4 w-4 flex-none items-center justify-center rounded text-ink-500 opacity-0 transition-opacity hover:bg-ink-700 hover:text-ink-100 focus:opacity-100 group-hover:opacity-100"
                  title={t("sidebar.closeTab")}
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(tab.connectionId);
                  }}
                >
                  <X size={11} />
                </button>
              </div>
            );
          })}
        </div>
        <button
          className="mb-1 ml-1 flex flex-none items-center rounded px-1.5 py-1 text-ink-400 transition-colors hover:bg-ink-800 hover:text-ink-100"
          title={t("sidebar.addConnection")}
          onClick={onAddConnection}
        >
          <Plus size={13} />
        </button>
      </div>
    </>
  );
}
