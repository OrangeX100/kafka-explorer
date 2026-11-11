import { useCallback, useEffect, useState } from "react";
import { connectApi, friendlyError } from "../../shared/api.js";
import { useToast } from "../../state/stores.js";
import { t } from "../../shared/i18n.js";
import { SkeletonLines } from "../common/Skeleton.js";
import { EmptyState } from "../common/EmptyState.js";
import { ErrorHint } from "../common/ErrorHint.js";
import { useContextMenu } from "../common/ContextMenu.js";
import { confirmDialog } from "../common/ConfirmDialog.js";
import { Modal } from "../common/Modal.js";
import { useCopy } from "../../shared/useCopy.js";
import { Plus, PlugZap, Copy, Trash2 } from "lucide-react";
import type { ConnectorSummary } from "../../shared/contracts-admin.js";

import type { ConnectCluster } from "../../shared/contracts-admin.js";
import { ConnectorDetailModal, CreateConnectorModal } from "./ConnectDialogs.js";
import { ConnectAuthFields } from "./KsqlDialogs.js";

// ConnectView: saved Connect clusters + connector list with lifecycle ops.
// Failure policy: a failed load shows an inline ErrorHint with a manual
// retry — it NEVER auto-retries. (The original code re-fetched whenever
// `toast` identity changed: useToast() without a selector returns the whole
// store object, toast.show() updates it, the load useCallback rebuilt, the
// [load] effect re-ran → skeleton flashing + one error toast per loop,
// forever. Subscribing via (s) => s.show — a stable store action — breaks
// the cycle, and page-level failures surface as banners instead of toast
// storms.)
export function ConnectView() {
  const [clusters, setClusters] = useState<ConnectCluster[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [connectors, setConnectors] = useState<ConnectorSummary[] | null>(null);
  const [connectorsError, setConnectorsError] = useState<unknown>(null);
  const [creatingCluster, setCreatingCluster] = useState(false);
  const [creatingConnector, setCreatingConnector] = useState(false);
  // name of the connector whose detail modal is open (null = closed)
  const [detailName, setDetailName] = useState<string | null>(null);
  const toast = { show: useToast((s) => s.show) };

  const load = useCallback(async () => {
    setClusters(null);
    setLoadError(null);
    try {
      const list = (await connectApi.list()) ?? [];
      setClusters(list);
      if (list.length > 0) setActiveId((cur) => cur ?? list[0].id);
    } catch (err) {
      setLoadError(err);
      setClusters([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // silent: keep the current rows mounted and swap in place — the skeleton
  // unmount/remount was a visible flash on every lifecycle action. Full
  // (skeleton) reload is only for cluster switches and manual retries.
  const loadConnectors = useCallback(async (id: string, silent = false) => {
    if (!silent) setConnectors(null);
    setConnectorsError(null);
    try {
      setConnectors((await connectApi.connectors(id)) ?? []);
    } catch (err) {
      setConnectorsError(err);
      if (!silent) setConnectors([]);
    }
  }, []);

  useEffect(() => {
    if (activeId) void loadConnectors(activeId);
  }, [activeId, loadConnectors]);

  const { open: openCtx, menu: ctxMenu } = useContextMenu();
  const copy = useCopy();
  const lifecycle = async (name: string, op: "restart" | "pause" | "resume") => {
    if (!activeId) return;
    try {
      await connectApi.lifecycle(activeId, name, op);
      toast.show(t(op === "restart" ? "connect.restartedOk" : op === "pause" ? "connect.pausedOk" : "connect.resumedOk", name), "ok");
      await loadConnectors(activeId, true);
    } catch (err) {
      toast.show(friendlyError(err), "error");
    }
  };

  const removeConnector = async (name: string) => {
    if (!activeId) return;
    if (!(await confirmDialog({ message: t("connect.deleteConnectorConfirm", name), danger: true }))) return;
    try {
      await connectApi.removeConnector(activeId, name);
      if (detailName === name) setDetailName(null);
      toast.show(t("connect.deletedOk", name), "ok");
      await loadConnectors(activeId);
    } catch (err) {
      toast.show(friendlyError(err), "error");
    }
  };

  const removeCluster = async (c: ConnectCluster) => {
    // Only the saved record is removed — the remote service is untouched.
    if (!(await confirmDialog({ message: t("connect.deleteClusterConfirm", c.name), danger: true }))) return;
    try {
      await connectApi.remove(c.id);
      toast.show(t("connect.deletedOk", c.name), "ok");
      if (activeId === c.id) setActiveId(null);
      await load();
    } catch (err) {
      toast.show(friendlyError(err), "error");
    }
  };

  const stateColor = (s: string) =>
    s === "RUNNING" ? "text-ok" : s === "FAILED" ? "text-danger" : "text-warn";

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-ink-950">
      <div className="flex items-center gap-1.5 border-b border-ink-700 bg-ink-900 px-2 py-1.5">
        <span className="px-1 text-xs font-semibold text-ink-200">Kafka Connect</span>
        <div className="flex-1" />
        <button className="btn" disabled={!activeId} onClick={() => setCreatingConnector(true)}>
          <PlugZap size={13} /> {t("connect.createConnector")}
        </button>
        <button className="btn btn-accent" onClick={() => setCreatingCluster(true)}>
          <Plus size={13} /> {t("connect.addCluster")}
        </button>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="w-60 flex-none overflow-y-auto border-r border-ink-700 bg-ink-900 py-1">
          {clusters === null && (
            <div className="px-3 py-3"><SkeletonLines rows={3} /></div>
          )}
          {loadError ? (
            <div className="px-2 py-2">
              <ErrorHint error={loadError} onRetry={() => void load()} compact />
            </div>
          ) : null}
          {(clusters ?? []).map((c) => (
            <div
              key={c.id}
              data-testid="connect-cluster"
              onContextMenu={(e) =>
                openCtx(e, [
                  { label: t("ctx.openCluster"), onSelect: () => setActiveId(c.id) },
                  { label: t("ctx.copyName"), icon: <Copy size={13} />, onSelect: () => copy(c.name) },
                  { label: t("ctx.copyUrl"), icon: <Copy size={13} />, onSelect: () => copy(c.url) },
                  { label: t("ctx.deleteCluster"), icon: <Trash2 size={13} />, danger: true, separatorBefore: true, onSelect: () => void removeCluster(c) },
                ])
              }
              onClick={() => setActiveId(c.id)}
              className={`cursor-pointer px-3 py-1.5 text-xs ${
                activeId === c.id ? "bg-accent-muted text-ink-100" : "text-ink-200 hover:bg-ink-800"
              }`}
            >
              <div className="truncate">{c.name}</div>
              <div className="truncate font-mono text-10 text-ink-400" title={c.url}>{c.url}</div>
            </div>
          ))}
        </div>
        <div className="anim-blur-in min-w-0 flex-1 overflow-auto">
          {connectors === null && activeId && (
            <div className="p-3"><SkeletonLines rows={5} /></div>
          )}
          {connectorsError ? (
            <div className="p-3">
              <ErrorHint error={connectorsError} onRetry={() => activeId && void loadConnectors(activeId)} />
            </div>
          ) : null}
          {connectors !== null && !connectorsError && connectors.length === 0 && (
            <EmptyState icon={<PlugZap size={20} />} title={t("connect.tabConnectors")} desc={t("connect.empty")} />
          )}
          {(connectors ?? []).map((c) => (
            <div
              key={c.name}
              data-testid="connector-row"
              onClick={() => setDetailName(c.name)}
              onContextMenu={(e) =>
                openCtx(e, [
                  { label: t("ctx.restartConnector"), onSelect: () => void lifecycle(c.name, "restart") },
                  // Gray out what the connector state can't do right now
                  // (pause a paused connector / resume a running one) —
                  // the API would accept it, the menu shouldn't offer it.
                  {
                    label: t("ctx.pauseConnector"),
                    disabled: c.state !== "RUNNING",
                    onSelect: () => void lifecycle(c.name, "pause"),
                  },
                  {
                    label: t("ctx.resumeConnector"),
                    disabled: c.state !== "PAUSED",
                    onSelect: () => void lifecycle(c.name, "resume"),
                  },
                  { label: t("ctx.copyConnectorName"), icon: <Copy size={13} />, onSelect: () => copy(c.name) },
                  { label: t("ctx.deleteConnector"), icon: <Trash2 size={13} />, danger: true, separatorBefore: true, onSelect: () => void removeConnector(c.name) },
                ])
              }
              className="group flex cursor-pointer items-center gap-3 border-b border-ink-800 px-3 py-2 text-xs hover:bg-ink-850">
              <span className="w-56 truncate font-mono text-ink-200" title={c.name}>{c.name}</span>
              <span className="rounded bg-ink-800 px-1.5 py-0.5 text-10 text-ink-300">{c.type}</span>
              <span className={`font-medium ${stateColor(c.state)}`}>{c.state}</span>
              <span className="flex-1 truncate text-10 text-ink-400" title={c.worker}>{c.worker}</span>
              <div className="flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                <button className="btn !px-1.5 !py-0.5" onClick={(e) => { e.stopPropagation(); void lifecycle(c.name, "restart"); }}>↻</button>
                <button className="btn !px-1.5 !py-0.5" onClick={(e) => { e.stopPropagation(); void lifecycle(c.name, "pause"); }}>⏸</button>
                <button className="btn !px-1.5 !py-0.5" onClick={(e) => { e.stopPropagation(); void lifecycle(c.name, "resume"); }}>▶</button>
              </div>
            </div>
          ))}
        </div>
        {ctxMenu}
      </div>

      {creatingCluster && (
        <ConnectClusterDialog
          onClose={() => setCreatingCluster(false)}
          onSaved={() => {
            setCreatingCluster(false);
            void load();
          }}
        />
      )}
      {creatingConnector && activeId && (
        <CreateConnectorModal
          clusterId={activeId}
          onClose={() => setCreatingConnector(false)}
          onCreated={() => {
            setCreatingConnector(false);
            if (activeId) void loadConnectors(activeId, true);
          }}
        />
      )}
      {detailName && activeId && (
        <ConnectorDetailModal
          clusterId={activeId}
          name={detailName}
          onClose={() => setDetailName(null)}
          onLifecyle={(op) => lifecycle(detailName, op)}
        />
      )}
    </main>
  );
}

function ConnectClusterDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const toast = { show: useToast((s) => s.show) };

  const save = async () => {
    try {
      await connectApi.save({ cluster: { id: "", name, url, username }, password });
      onSaved();
    } catch (err) {
      toast.show(friendlyError(err), "error");
    }
  };

  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      const version = await connectApi.test(url, username, password);
      setResult(t("reg.testOk", version));
    } catch (err) {
      setResult(String(err));
    } finally {
      setTesting(false);
    }
  };

  return (
    <Modal title={t("connect.addCluster")} width={420} onClose={onClose}>
      {(close) => (
        <div className="space-y-2.5">
          <label className="block">
            <span className="mb-1 block text-11 text-ink-300">{t("reg.name")}</span>
            <input className="field" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="block">
            <span className="mb-1 block text-11 text-ink-300">{t("reg.url")}</span>
            <input className="field font-mono" placeholder="http://host:8083" value={url} onChange={(e) => setUrl(e.target.value)} />
          </label>
          <ConnectAuthFields username={username} password={password} onUsername={setUsername} onPassword={setPassword} />
          {result && <div className="rounded border border-ink-600 bg-ink-900 px-2.5 py-2 text-11 selectable">{result}</div>}
          <div className="mt-3 flex items-center gap-2 border-t border-ink-700 pt-3">
            <button className="btn" disabled={testing} onClick={() => void test()}>
              <PlugZap size={13} /> {testing ? t("conn.testing") : t("reg.test")}
            </button>
            <div className="flex-1" />
            <button className="btn" onClick={close}>{t("conn.cancel")}</button>
            <button className="btn btn-accent" disabled={!name || !url} onClick={() => void save()}>{t("conn.save")}</button>
          </div>
        </div>
      )}
    </Modal>
  );
}
