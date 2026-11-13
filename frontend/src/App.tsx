import { useEffect, useState } from "react";
import { Events } from "@wailsio/runtime";
import { Cable, Copy } from "lucide-react";
import { useConnections } from "./state/stores.js";
import { useWorkspace } from "./state/workspace.js";
import { Sidebar } from "./features/shell/Sidebar.js";
import { TitleBar } from "./features/shell/TitleBar.js";
import { ClusterWorkspace } from "./features/shell/ClusterWorkspace.js";
import { ConnectionDialog } from "./features/connections/ConnectionDialog.js";
import { ToastHost } from "./features/common/Toast.js";
import { ConfirmHost } from "./features/common/ConfirmDialog.js";
import { useAppSettings } from "./state/settings.js";
import { EmptyState } from "./features/common/EmptyState.js";
import { RegistryView } from "./features/registry/RegistryView.js";
import { ConnectView } from "./features/admin/ConnectView.js";
import { KsqlDbView } from "./features/admin/KsqlDbView.js";
import { SettingsView } from "./features/settings/SettingsView.js";
import { useContextMenu } from "./features/common/ContextMenu.js";
import { useCopy } from "./shared/useCopy.js";
import { t } from "./shared/i18n.js";
import { systemApi } from "./shared/api.js";
import { useToast } from "./state/stores.js";

type TopView = "clusters" | "registries" | "connect" | "ksqldb" | "settings";

export default function App() {
  const refresh = useConnections((s) => s.refresh);
  const activeId = useWorkspace((s) => s.activeId);
  const [editing, setEditing] = useState<null | { id?: string }>(null);
  const [topView, setTopView] = useState<TopView>("clusters");
  const { open: openFallback, menu: fallbackMenu } = useContextMenu();
  const copy = useCopy();
  // (s) => s.show: the whole-store object changes identity on every toast,
  // which would re-run this effect (and re-fire the update check) forever
  // whenever a new version is found.
  const toast = { show: useToast((s) => s.show) };

  const loadSettings = useAppSettings((s) => s.load);
  // ✕ → tray hint: the Go side emits tray:minimized on the first hide; the
  // hint itself shows once per machine (localStorage dedupe) so it never
  // nags a user who already knows where the window went.
  useEffect(() => {
    const off = Events.On("tray:minimized", () => {
      if (localStorage.getItem("ke.trayHintShown")) return;
      localStorage.setItem("ke.trayHintShown", "1");
      toast.show(t("tray.hint"), "info");
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    void refresh();
    void loadSettings().then(() => {
      // One-shot update check at boot (setting-gated): silent on failure —
      // a network problem must never become a startup error toast. The
      // reminder fires ONCE PER VERSION (ke.updateNotifiedAtVersion): a
      // user who defers the update must not be re-nagged every launch.
      const s = useAppSettings.getState().settings;
      if (!s?.autoCheckUpdate || !s.updateRepo) return;
      systemApi
        .checkUpdate(s.updateRepo)
        .then((r) => {
          if (!r.hasUpdate) return;
          if (localStorage.getItem("ke.updateNotifiedAtVersion") === r.latest) return;
          localStorage.setItem("ke.updateNotifiedAtVersion", r.latest);
          toast.show(t("settings.autoCheckFound", r.latest), "info");
        })
        .catch(() => {});
    });
  }, [refresh, loadSettings, toast]);

  // Suppress the WebView2 default context menu everywhere. Surfaces with
  // their own app menu call preventDefault+stopPropagation first, so this
  // window-level listener only fires on UNCOVERED surfaces — where it either
  // offers "copy selection" or just suppresses.
  useEffect(() => {
    const onCtx = (e: MouseEvent) => {
      const selection = window.getSelection()?.toString() ?? "";
      e.preventDefault();
      if (selection.length > 0) {
        openFallback(e as unknown as React.MouseEvent, [
          { label: t("ctx.copySelection"), icon: <Copy size={13} />, onSelect: () => copy(selection) },
        ]);
      }
    };
    window.addEventListener("contextmenu", onCtx);
    return () => window.removeEventListener("contextmenu", onCtx);
  }, [openFallback, copy]);

  return (
    <div className="flex h-full flex-col">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <Sidebar
          onAddConnection={() => setEditing({})}
          onEditConnection={(id) => setEditing({ id })}
          topView={topView}
          setTopView={setTopView}
        />
        {topView === "registries" ? (
          <RegistryView />
        ) : topView === "ksqldb" ? (
          <KsqlDbView />
        ) : topView === "connect" ? (
          <ConnectView />
        ) : topView === "settings" ? (
          <main className="flex-1 overflow-auto bg-ink-950">
            <SettingsView />
          </main>
        ) : activeId ? (
        <ClusterWorkspace onAddConnection={() => setEditing({})} />
      ) : (
        <main className="flex flex-1 items-center justify-center bg-ink-950">
          <div className="h-64">
            <EmptyState
              icon={<Cable size={22} />}
              title={t("app.title")}
              desc={t("sidebar.empty")}
              action={{ label: t("sidebar.addConnection"), onClick: () => setEditing({}) }}
            />
          </div>
        </main>
      )}

      {editing !== null && (
        <ConnectionDialog
          connectionId={editing.id}
          onClose={() => setEditing(null)}
        />
      )}

      {fallbackMenu}
      <ToastHost />
      <ConfirmHost />
      </div>
    </div>
  );
}
