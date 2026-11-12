import { useCallback, useEffect, useState } from "react";
import { connectApi, friendlyError } from "../../shared/api.js";
import { useToast } from "../../state/stores.js";
import { t } from "../../shared/i18n.js";
import { Modal } from "../common/Modal.js";
import { Select } from "../common/controls.js";
import { ErrorHint } from "../common/ErrorHint.js";
import { PlugZap, RefreshCw } from "lucide-react";
import type { ConnectorDetail } from "../../shared/contracts-admin.js";

// Friendly one-line description per known plugin class suffix; unknown
// plugins fall back to their simple class name. The full FQCN is shown in
// its own line under the select so long names never truncate.
const PLUGIN_DESC: Record<string, string> = {
  FileStreamSourceConnector: "connect.pluginFileSource",
  FileStreamSinkConnector: "connect.pluginFileSink",
  MirrorSourceConnector: "connect.pluginMirrorSource",
  MirrorCheckpointConnector: "connect.pluginMirrorCheckpoint",
  MirrorHeartbeatConnector: "connect.pluginMirrorHeartbeat",
};

const pluginLabel = (cls: string): string => {
  const simple = cls.split(".").pop() ?? cls;
  const key = PLUGIN_DESC[simple];
  return key ? `${simple} · ${t(key)}` : simple;
};

// ConnectorDetailModal: one connector's tasks + config. A FAILED task's
// trace is the whole point of this view (it names the misbehaving config
// key), so it renders as a selectable red block — read-only, copyable.
export function ConnectorDetailModal({
  clusterId,
  name,
  onClose,
  onLifecyle,
}: {
  clusterId: string;
  name: string;
  onClose: () => void;
  // Runs the parent lifecycle op (toast + silent list refresh) and then
  // reloads THIS modal's detail — without the self-reload the paused state
  // stayed stale and the buttons kept their old disabled mapping.
  onLifecyle: (op: "restart" | "pause" | "resume") => Promise<void>;
}) {
  const [detail, setDetail] = useState<ConnectorDetail | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [editingConfig, setEditingConfig] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    setBusy(true);
    try {
      setDetail(await connectApi.detail(clusterId, name));
    } catch (err) {
      setLoadError(err);
    } finally {
      setBusy(false);
    }
  }, [clusterId, name]);

  const onLifecyleThenReload = async (op: "restart" | "pause" | "resume") => {
    await onLifecyle(op);
    await load();
    // Task statuses ride the status topic and can lag the connector state
    // by seconds (the modal used to freeze that lag on screen: connector
    // PAUSED with tasks still RUNNING). A settling second snapshot shows
    // the truth once propagation finishes.
    await new Promise((r) => setTimeout(r, 2500));
    await load();
  };

  // Single-task restart: the narrow fix for one stuck task. Same settle
  // snapshot as lifecycle ops — the task state lags the restart by seconds.
  const restartTaskThenReload = async (taskId: number) => {
    try {
      await connectApi.restartTask(clusterId, name, taskId);
      toast.show(t("connect.taskRestartOk", String(taskId)), "ok");
    } catch (err) {
      toast.show(friendlyError(err), "error");
      return;
    }
    await load();
    await new Promise((r) => setTimeout(r, 2500));
    await load();
  };

  useEffect(() => {
    void load();
  }, [load]);

  const stateColor = (s: string) =>
    s === "RUNNING" ? "text-ok" : s === "FAILED" ? "text-danger" : "text-warn";

  return (
    <Modal title={`${t("connect.detail")} · ${name}`} width={560} onClose={onClose}>
      {(close) => (
        <div className="space-y-3">
          {detail && (
            <div className="flex items-center gap-2 text-11">
              <span className="rounded bg-ink-800 px-1.5 py-0.5 text-ink-300">{detail.type}</span>
              <span className={`font-medium ${stateColor(detail.state)}`}>{detail.state}</span>
              <span className="truncate font-mono text-ink-400" title={detail.worker}>{detail.worker}</span>
              <div className="flex-1" />
              <button className="btn !px-1.5 !py-0.5" title={t("topics.refresh")} disabled={busy} onClick={() => void load()}>
                <RefreshCw size={12} />
              </button>
            </div>
          )}
          {loadError !== null && (
            <ErrorHint error={loadError} onRetry={() => void load()} />
          )}
          {/* Pause semantics: task threads stop moving data but their status
              can lag the connector state by seconds (verified on 4.2: data
              flow stops immediately). Explained instead of hidden. */}
          {detail?.state === "PAUSED" && detail.tasks.some((task) => task.state === "RUNNING") && (
            <div className="rounded border border-warn/40 bg-warn/10 px-2.5 py-1.5 text-11 text-warn">
              {t("connect.pausedTaskNote")}
            </div>
          )}
          {detail && detail.tasks.length > 0 && (
            <div>
              <div className="mb-1 text-11 font-semibold text-ink-300">{t("connect.tasks")}</div>
              <table className="w-full table-fixed border-collapse text-11">
                <thead>
                  <tr>
                    <th className="table-head w-14 px-2 py-1 text-left">#</th>
                    <th className="table-head w-24 px-2 py-1 text-left">{t("connect.taskState")}</th>
                    <th className="table-head px-2 py-1 text-left">{t("connect.taskWorker")}</th>
                    <th className="table-head w-20 px-2 py-1 text-center">{t("connect.taskRestart")}</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.tasks.map((task) => (
                    <tr key={task.id} className="border-b border-ink-800">
                      <td className="px-2 py-1 font-mono">{task.id}</td>
                      <td className={`px-2 py-1 font-medium ${stateColor(task.state)}`}>{task.state}</td>
                      <td className="truncate px-2 py-1 font-mono text-ink-400" title={task.worker}>{task.worker || "∅"}</td>
                      <td className="px-2 py-1 text-center">
                        <button
                          className="btn !px-1.5 !py-0.5"
                          title={t("connect.taskRestartHint")}
                          onClick={() => void restartTaskThenReload(task.id)}
                        >
                          ↻
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {detail.tasks.filter((task) => task.state === "FAILED" && task.trace).map((task) => (
                <pre key={task.id} className="selectable mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded border border-danger/40 bg-danger/10 px-2 py-1.5 text-10 text-danger">
                  {task.trace}
                </pre>
              ))}
            </div>
          )}
          {detail && (
            <div>
              <div className="mb-1 text-11 font-semibold text-ink-300">{t("connect.config")}</div>
              <div className="max-h-52 overflow-y-auto rounded border border-ink-700">
                {Object.entries(detail.config).map(([k, v]) => (
                  <div key={k} className="flex gap-2 border-b border-ink-800 px-2 py-1 text-11 last:border-b-0">
                    <span className="w-56 flex-none truncate font-mono text-ink-300" title={k}>{k}</span>
                    <span className="min-w-0 flex-1 break-all font-mono text-ink-100 selectable">{v}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="flex items-center gap-2 border-t border-ink-700 pt-3">
            <button className="btn" disabled={!detail || detail.state !== "RUNNING"} onClick={() => void onLifecyleThenReload("pause")}>⏸ {t("ctx.pauseConnector")}</button>
            <button className="btn" disabled={!detail || detail.state !== "PAUSED"} onClick={() => void onLifecyleThenReload("resume")}>▶ {t("ctx.resumeConnector")}</button>
            <button className="btn" disabled={!detail} onClick={() => void onLifecyleThenReload("restart")}>↻ {t("ctx.restartConnector")}</button>
            <button className="btn" disabled={!detail} onClick={() => setEditingConfig(true)}>{t("connect.editConfig")}</button>
            <div className="flex-1" />
            <button className="btn" onClick={close}>{t("conn.cancel")}</button>
          </div>
          {detail && editingConfig && (
            <EditConnectorConfigModal
              clusterId={clusterId}
              connector={detail}
              onClose={() => setEditingConfig(false)}
              onSaved={async () => {
                setEditingConfig(false);
                await load();
              }}
            />
          )}
        </div>
      )}
    </Modal>
  );
}

// EditConnectorConfigModal: PUT the connector's config back to the cluster
// (the update path the detail view could only show read-only before). The
// JSON editor pre-fills from the live config; connector.class must survive
// the edit — it defines the plugin and the backend rejects its absence.
function EditConnectorConfigModal({
  clusterId,
  connector,
  onClose,
  onSaved,
}: {
  clusterId: string;
  connector: ConnectorDetail;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [configText, setConfigText] = useState(JSON.stringify(connector.config, null, 2));
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const toast = { show: useToast((s) => s.show) };

  const save = async () => {
    setFormError(null);
    let config: Record<string, string>;
    try {
      const parsed = JSON.parse(configText || "{}") as Record<string, unknown>;
      config = {};
      for (const [k, v] of Object.entries(parsed)) config[k] = String(v);
    } catch {
      setFormError(t("connect.jsonInvalid"));
      return;
    }
    if (!config["connector.class"]) {
      setFormError(t("connect.classRequired"));
      return;
    }
    setSaving(true);
    try {
      await connectApi.updateConnector(clusterId, connector.name, config);
      toast.show(t("connect.updateOk", connector.name), "ok");
      await onSaved();
    } catch (err) {
      setFormError(friendlyError(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={t("connect.editConfigTitle", connector.name)} width={480} onClose={onClose}>
      {(close) => (
        <div className="space-y-2.5">
          <label className="block">
            <span className="mb-1 block text-11 text-ink-300">{t("connect.configJson")}</span>
            <textarea
              className="field h-48 resize-y font-mono text-11"
              value={configText}
              onChange={(e) => setConfigText(e.target.value)}
              spellCheck={false}
            />
          </label>
          <div className="text-10 text-ink-400">{t("connect.updateHint")}</div>
          {formError && (
            <div className="rounded border border-danger/40 bg-danger/10 px-2.5 py-2 text-11 text-danger selectable">{formError}</div>
          )}
          <div className="flex items-center gap-2 border-t border-ink-700 pt-3">
            <div className="flex-1" />
            <button className="btn" onClick={close}>{t("conn.cancel")}</button>
            <button className="btn btn-accent" disabled={saving} onClick={() => void save()}>{t("conn.save")}</button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// templateFor pre-fills a workable config for the built-in file connectors —
// the paths are the worker container's mounted /data volume. Unknown plugins
// get the minimal skeleton; connector.class is what Connect requires.
function templateFor(cls: string): Record<string, string> {
  const base: Record<string, string> = { "connector.class": cls, "tasks.max": "1" };
  if (cls.includes("FileStreamSource")) {
    return { ...base, file: "/data/source.txt", topic: "connect-demo" };
  }
  if (cls.includes("FileStreamSink")) {
    return { ...base, file: "/data/sink.txt", topics: "connect-demo" };
  }
  return base;
}

// CreateConnectorModal: name + plugin dropdown (live from /connector-plugins)
// + JSON config editor. The JSON text is the source of truth — the template
// just seeds it, user edits freely.
export function CreateConnectorModal({
  clusterId,
  onClose,
  onCreated,
}: {
  clusterId: string;
  onClose: () => void;
  onCreated: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const [plugins, setPlugins] = useState<string[] | null>(null);
  const [pluginsError, setPluginsError] = useState<unknown>(null);
  const [plugin, setPlugin] = useState("");
  const [configText, setConfigText] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const toast = { show: useToast((s) => s.show) };

  // desktop-tool parity: show EVERY plugin the cluster reports (file + mirror + any
  // user-installed ones) — the earlier mirror filter left only 2 of 5.
  const shortPlugins = (list: string[]) => list.map((p) => p.replace(/^[^:]+: /, ""));

  const loadPlugins = useCallback(() => {
    setPluginsError(null);
    void connectApi
      .plugins(clusterId)
      .then((list) => {
        const short = shortPlugins(list ?? []);
        setPlugins(short);
        if (short.length > 0) {
          setPlugin(short[0]);
          setConfigText(JSON.stringify(templateFor(short[0]), null, 2));
        }
      })
      .catch((err) => setPluginsError(err));
  }, [clusterId]);

  useEffect(() => {
    loadPlugins();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clusterId]);

  // Picking a plugin re-seeds the JSON only when the user has not edited it
  // away from the previous plugin's template — free-form edits survive.
  const pickPlugin = (cls: string) => {
    setPlugin(cls);
    try {
      const cur = JSON.parse(configText || "{}") as Record<string, string>;
      if (cur["connector.class"] === plugin || Object.keys(cur).length <= 2) {
        setConfigText(JSON.stringify(templateFor(cls), null, 2));
      }
    } catch {
      setConfigText(JSON.stringify(templateFor(cls), null, 2));
    }
  };

  const create = async () => {
    setFormError(null);
    let config: Record<string, string>;
    try {
      const parsed = JSON.parse(configText || "{}") as Record<string, unknown>;
      config = {};
      for (const [k, v] of Object.entries(parsed)) config[k] = String(v);
    } catch {
      setFormError(t("connect.jsonInvalid"));
      return;
    }
    if (!config["connector.class"]) {
      setFormError(t("connect.classRequired"));
      return;
    }
    setCreating(true);
    try {
      await connectApi.createConnector({ connectionId: clusterId, name: name.trim(), config });
      toast.show(t("connect.createOk", name.trim()), "ok");
      onCreated(name.trim());
    } catch (err) {
      setFormError(friendlyError(err));
    } finally {
      setCreating(false);
    }
  };

  return (
    <Modal title={t("connect.createConnector")} width={480} onClose={onClose}>
      {(close) => (
        <div className="space-y-2.5">
          <label className="block">
            <span className="mb-1 block text-11 text-ink-300">{t("reg.name")}</span>
            <input className="field font-mono" placeholder="file-source-demo" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <div>
            <span className="mb-1 block text-11 text-ink-300">{t("connect.plugin")}</span>
            {pluginsError !== null ? (
              <ErrorHint error={pluginsError} onRetry={loadPlugins} />
            ) : plugins === null ? (
              <div className="field opacity-50">…</div>
            ) : plugins.length === 0 ? (
              <div className="field opacity-50">{t("connect.noPlugins")}</div>
            ) : (
              <>
                <Select value={plugin} options={plugins.map((p) => ({ value: p, label: pluginLabel(p) }))} onChange={pickPlugin} />
                {/* Full class name on its own wrapping line — the friendly
                    label above stays short, the exact connector.class value
                    is what lands in the JSON and must never be truncated. */}
                <div className="mt-1 break-all font-mono text-10 text-ink-400 selectable" title={plugin}>
                  {plugin}
                </div>
              </>
            )}
          </div>
          <label className="block">
            <span className="mb-1 block text-11 text-ink-300">{t("connect.configJson")}</span>
            <textarea
              className="field h-40 resize-y font-mono text-11"
              value={configText}
              onChange={(e) => setConfigText(e.target.value)}
              spellCheck={false}
            />
          </label>
          <div className="text-10 text-ink-400">{t("connect.configJsonHint")}</div>
          {formError && (
            <div className="rounded border border-danger/40 bg-danger/10 px-2.5 py-2 text-11 text-danger selectable">{formError}</div>
          )}
          <div className="flex items-center gap-2 border-t border-ink-700 pt-3">
            <PlugZap size={13} className="text-ink-400" />
            <div className="flex-1" />
            <button className="btn" onClick={close}>{t("conn.cancel")}</button>
            <button className="btn btn-accent" disabled={!name.trim() || creating || plugins?.length === 0} onClick={() => void create()}>{t("conn.save")}</button>
          </div>
        </div>
      )}
    </Modal>
  );
}
