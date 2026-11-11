import { useState } from "react";
import { adminApi } from "../../shared/api.js";
import { Modal } from "../common/Modal.js";
import { useToast } from "../../state/stores.js";
import { t } from "../../shared/i18n.js";
import { configHint, configPresets } from "../../shared/humanize.js";
import { configName, configDescParts } from "../../shared/configLocale.js";
import { Switch } from "../common/controls.js";
import type { ConfigEntry } from "../../shared/contracts.js";
import { friendlyError } from "../../shared/api.js";

// Kind detection shared with topic configs, but broker boolean configs are
// the *.enable family (plus a couple of explicit ones).
export function brokerConfigKind(name: string, value: string): "bool" | "text" {
  if (name.endsWith(".enable") || value === "true" || value === "false") return "bool";
  return "text";
}

// BrokerConfigEditDialog: change one broker config, or revert the override
// back to the cluster default (explicit DELETE op). Dynamic configs apply
// instantly; static ones never reach this dialog (read-only in the table).
export function BrokerConfigEditDialog({
  connectionId,
  brokerId,
  entry,
  onClose,
  onSaved,
}: {
  connectionId: string;
  brokerId: number;
  entry: ConfigEntry;
  onClose: () => void;
  onSaved: () => void;
}) {
  // ReadOnly configs (static / sensitive) open the same dialog in view-only
  // mode: value replaced by plain text, save & revert hidden.
  const viewOnly = entry.readOnly || entry.sensitive;
  const [value, setValue] = useState(entry.value);
  const [revert, setRevert] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const save = async () => {
    setBusy(true);
    try {
      await adminApi.alterBrokerConfig({
        connectionId,
        brokerId,
        values: { [entry.name]: revert ? null : value },
      });
      toast.show(`${entry.name} = ${revert ? t("toast.reverted") : value}`, "ok");
      onSaved();
      onClose();
    } catch (err) {
      // Static (restart-only) configs surface the broker's own explanation.
      toast.show(friendlyError(err), "error");
    } finally {
      setBusy(false);
    }
  };

  const kind = brokerConfigKind(entry.name, entry.value);
  const hint = configHint(entry.name, entry.value);
  const presets = configPresets(entry.name);

  return (
    <ModalShell
      title={`${viewOnly ? t("config.viewTitle") : t("config.edit")} — ${configName(entry.name)}`}
      onClose={onClose}
      busy={busy}
      onSave={viewOnly ? undefined : () => void save()}
      body={
        <div className="space-y-2.5">
          <div className="rounded border border-ink-700 bg-ink-900 px-2.5 py-2 text-11 text-ink-300">
            <div className="font-mono text-ink-200">{entry.name}</div>
            {(() => {
              const { summary, official } = configDescParts(entry.name, entry.doc);
              const zh = localStorage.getItem("ke.locale") === "zh-CN";
              return (
                <div className="mt-1 space-y-1.5">
                  {summary && <div className="text-ink-200">{summary}</div>}
                  {official && official !== summary && (
                    <div>
                      {zh && summary && <div className="mb-0.5 text-10 text-ink-500">{t("config.officialDocs")}</div>}
                      <div className="max-h-40 overflow-auto whitespace-pre-wrap leading-relaxed text-ink-400">{official}</div>
                    </div>
                  )}
                </div>
              );
            })()}
            {entry.defaultValue !== "" && (
              <div className="mt-1.5 flex items-center gap-2">
                <span className="text-ink-400">
                  {t("config.defaultValue")}：<span className="font-mono text-ink-200">{entry.defaultValue}</span>
                  {(() => {
                    const h = configHint(entry.name, entry.defaultValue);
                    return h ? <span className="ml-1 text-ink-400">（{h}）</span> : null;
                  })()}
                </span>
                {!viewOnly && !revert && value !== entry.defaultValue && (
                  <button
                    type="button"
                    className="rounded border border-ink-600 px-1.5 py-0.5 text-10 text-ink-300 transition-colors hover:border-ink-500 hover:text-ink-100"
                    onClick={() => setValue(entry.defaultValue)}
                  >
                    {t("config.fillDefault")}
                  </button>
                )}
              </div>
            )}
            {!viewOnly && (
              <div className="mt-1 text-10 text-warn">
                {t("config.brokerWarn")}
              </div>
            )}
          </div>
          <label className="block">
            <span className="mb-1 block text-11 text-ink-300">
              {t("config.value")}（{t("config.current", entry.value || "∅")}）
            </span>
            <div className={revert || viewOnly ? "pointer-events-none opacity-40" : ""}>
              {kind === "bool" ? (
                <div className="flex items-center gap-2">
                  <Switch checked={value === "true"} onChange={(v) => setValue(v ? "true" : "false")} />
                  <span className="font-mono text-11 text-ink-300">{value || "false"}</span>
                </div>
              ) : (
                <textarea className="field h-20 font-mono" value={value} readOnly={viewOnly} onChange={(e) => setValue(e.target.value)} />
              )}
            </div>
          </label>
          {hint && <div className="text-11 text-ink-400">{hint}</div>}
          {!viewOnly && presets.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {presets.map((p) => (
                <button
                  key={p.value}
                  type="button"
                  className={`rounded border px-2 py-0.5 text-10 transition-colors ${
                    value === p.value
                      ? "border-accent/60 bg-accent-muted/40 text-accent"
                      : "border-ink-600 bg-ink-900 text-ink-300 hover:border-ink-500 hover:text-ink-100"
                  }`}
                  onClick={() => setValue(p.value)}
                >
                  {p.label}
                </button>
              ))}
            </div>
          )}
          {!viewOnly && (
            <div
              className={`flex items-center justify-between gap-3 rounded border px-2.5 py-2 transition-colors ${
                revert ? "border-accent/60 bg-accent-muted/30" : "border-ink-700 bg-ink-900"
              }`}
            >
              <span className="text-11 leading-relaxed text-ink-300">
                {t("config.revertSwitch")}
              </span>
              <Switch checked={revert} onChange={setRevert} />
            </div>
          )}
        </div>
      }
    />
  );
}

// Thin Modal wrapper keeping the footer wiring in one place.
function ModalShell({
  title,
  onClose,
  busy,
  onSave,
  body,
}: {
  title: string;
  onClose: () => void;
  busy: boolean;
  onSave?: () => void; // undefined = view-only dialog, footer shows close only
  body: React.ReactNode;
}) {
  return (
    <Modal title={title} width={520} onClose={onClose}>
      {(close) => (
        <div>
          {body}
          <div className="mt-3 flex justify-end gap-2 border-t border-ink-700 pt-3">
            <button className="btn" onClick={close}>
              {t("common.close")}
            </button>
            {onSave && (
              <button className="btn btn-accent" disabled={busy} onClick={onSave}>
                {t("conn.save")}
              </button>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
