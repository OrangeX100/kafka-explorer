import { useMemo, useState } from "react";
import { topicsApi } from "../../shared/api.js";
import { useToast } from "../../state/stores.js";
import { t } from "../../shared/i18n.js";
import { CONFIG_OPTIONS, BOOLEAN_CONFIGS } from "../../shared/topicConfigDocs.js";
import { configHint, configPresets } from "../../shared/humanize.js";
import { configName, configDesc, configDescParts } from "../../shared/configLocale.js";
import { Modal } from "../common/Modal.js";
import { Select, Switch } from "../common/controls.js";
import type { ConfigEntry } from "../../shared/contracts.js";
import { friendlyError } from "../../shared/api.js";

type ConfigKind = "bool" | "enum" | "text";

export function configKind(name: string, value: string): ConfigKind {
  if (BOOLEAN_CONFIGS.has(name) || value === "true" || value === "false") return "bool";
  if (CONFIG_OPTIONS[name]) return "enum";
  return "text";
}

// Kind-aware value editor shared by the edit and add dialogs. `value` is
// controlled by the parent so live preview (e.g. toggle) works before save.
// Duration/byte configs get a human hint (无上限 / ≈ 7 天 / ≈ 1 GB) and
// preset chips that convert back to the raw unit.
export function ValueEditor({
  name,
  value,
  onChange,
}: {
  name: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const kind = configKind(name, value);
  const hint = configHint(name, value);
  const presets = configPresets(name);
  return (
    <div className="space-y-1.5">
      {kind === "bool" ? (
        <div className="flex items-center gap-2">
          <Switch checked={value === "true"} onChange={(v) => onChange(v ? "true" : "false")} />
          <span className="font-mono text-11 text-ink-300">{value || "false"}</span>
        </div>
      ) : kind === "enum" ? (
        (() => {
          const options = CONFIG_OPTIONS[name] ?? [];
          const opts = [
            ...options.map((o) => ({ value: o, label: o })),
            ...(value && !options.includes(value) ? [{ value, label: value }] : []),
          ];
          return <Select value={value} options={opts} onChange={onChange} />;
        })()
      ) : (
        <textarea className="field h-20 font-mono" value={value} onChange={(e) => onChange(e.target.value)} />
      )}
      {hint && <div className="text-11 text-ink-400">{hint}</div>}
      {presets.length > 0 && (
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
              onClick={() => onChange(p.value)}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// AddConfigDialog: set an override for any known config. The name box
// fuzzy-matches the caller-supplied dictionary (key or Chinese label); the
// broker still validates unknown names, and its error surfaces verbatim.
// Shared by the topic page (TOPIC_CONFIG_DOCS + alterConfig) and the broker
// page (BROKER_CONFIG_DOCS + alterBrokerConfig).
export function AddConfigDialog({
  docs,
  existing,
  alter,
  onClose,
  onSaved,
}: {
  docs: Record<string, { zh: string; desc: string }>;
  existing: ConfigEntry[];
  alter: (name: string, value: string) => Promise<void>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [picked, setPicked] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const query = name.trim().toLowerCase();
  const suggestions = useMemo(() => {
    if (!query || picked) return [];
    return Object.entries(docs)
      .filter(
        ([k, m]) =>
          k.toLowerCase().includes(query) || m.zh.toLowerCase().includes(query) || m.desc.toLowerCase().includes(query),
      )
      .slice(0, 8);
  }, [query, picked, docs]);

  const pick = (k: string) => {
    setName(k);
    setPicked(true); // close the dropdown — it would stay open (the exact
    // name still matches) and cover the value editor below
    const current = existing.find((c) => c.name === k);
    if (current) {
      setValue(current.value);
      return;
    }
    // New override: seed a sensible starting value instead of an empty box.
    if (BOOLEAN_CONFIGS.has(k)) setValue("true");
    else if (CONFIG_OPTIONS[k]) setValue(CONFIG_OPTIONS[k][0] ?? "");
    else setValue("");
  };

  const submit = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await alter(name.trim(), value);
      toast.show(`${name.trim()} = ${value === "" ? t("toast.emptyValue") : value}`, "ok");
      onSaved();
      onClose();
    } catch (err) {
      toast.show(friendlyError(err), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={t("config.add")} width={520} onClose={onClose}>
      {(close) => (
        <div className="space-y-3">
          <label className="relative block">
            <span className="mb-1 block text-11 text-ink-300">{t("config.key")}</span>
            <input
              className="field font-mono"
              placeholder={t("config.addHint")}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setPicked(false);
              }}
            />
            {suggestions.length > 0 && (
              <div className="anim-fade absolute left-0 right-0 top-full z-10 mt-1 max-h-64 overflow-auto rounded border border-ink-600 bg-ink-850 py-1 shadow-2xl">
                {suggestions.map(([k]) => {
                  const covered = existing.some((c) => c.name === k && !c.default);
                  return (
                    <button
                      key={k}
                      type="button"
                      className="flex w-full flex-col items-start px-3 py-1.5 text-left hover:bg-ink-700"
                      onClick={() => pick(k)}
                    >
                      <span className="font-mono text-11 text-ink-100">
                        {k}
                        {covered && <span className="ml-2 rounded bg-accent-muted px-1 text-10 text-accent">{t("config.covered")}</span>}
                      </span>
                      <span className="text-10 text-ink-300">
                        {configName(k)} — {configDesc(k)}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </label>
          {name.trim() !== "" && (
            <div className="rounded border border-ink-700 bg-ink-900 px-2.5 py-2 text-11 text-ink-300">
              <span className="text-ink-100">{configName(name.trim())}</span> — {configDesc(name.trim())}
            </div>
          )}
          <label className="block">
            <span className="mb-1 block text-11 text-ink-300">{t("config.value")}</span>
            {name.trim() !== "" && (
              <div className="mt-1.5">
                <ValueEditor name={name.trim()} value={value} onChange={setValue} />
              </div>
            )}
          </label>
          <div className="mt-2 flex justify-end gap-2 border-t border-ink-700 pt-3">
            <button className="btn" onClick={close}>
              {t("common.cancel")}
            </button>
            <button className="btn btn-accent" disabled={busy || !name.trim()} onClick={() => void submit()}>
              {t("conn.save")}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ConfigEditDialog: change one entry's value, or revert the override to the
// cluster default (explicit DELETE op in the backend).
export function ConfigEditDialog({
  connectionId,
  topic,
  entry,
  onClose,
  onSaved,
}: {
  connectionId: string;
  topic: string;
  entry: ConfigEntry;
  onClose: () => void;
  onSaved: () => void;
}) {
  const viewOnly = entry.readOnly || entry.sensitive;
  const [value, setValue] = useState(entry.value);
  const [revert, setRevert] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const closeRef = { current: onClose };

  const save = async () => {
    setBusy(true);
    try {
      await topicsApi.alterConfig({
        connectionId,
        topic,
        values: { [entry.name]: revert ? null : value },
      });
      toast.show(`${entry.name} = ${revert ? t("toast.reverted") : value}`, "ok");
      onSaved();
      closeRef.current();
    } catch (err) {
      toast.show(friendlyError(err), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`${viewOnly ? t("config.viewTitle") : t("config.edit")} — ${configName(entry.name)}`} width={520} onClose={onClose}>
      {(close) => {
        closeRef.current = close;
        return (
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
                      const hint = configHint(entry.name, entry.defaultValue);
                      return hint ? <span className="ml-1 text-ink-400">（{hint}）</span> : null;
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
            </div>
            <label className="block">
              <span className="mb-1 block text-11 text-ink-300">
                {t("config.value")}（{t("config.current", entry.value || "∅")}）
              </span>
              <div className={revert || viewOnly ? "pointer-events-none opacity-40" : ""}>
                <ValueEditor name={entry.name} value={value} onChange={setValue} />
              </div>
            </label>
            {!viewOnly && (
              <div
                className={`flex items-center justify-between gap-3 rounded border px-2.5 py-2 transition-colors ${
                  revert ? "border-accent/60 bg-accent-muted/30" : "border-ink-700 bg-ink-900"
                }`}
              >
                <span className="text-11 leading-relaxed text-ink-300">{t("config.revertHint")}</span>
                <Switch checked={revert} onChange={setRevert} />
              </div>
            )}
            <div className="mt-3 flex justify-end gap-2 border-t border-ink-700 pt-3">
              <button className="btn" onClick={close}>
                {t("common.close")}
              </button>
              {!viewOnly && (
                <button className="btn btn-accent" disabled={busy} onClick={() => void save()}>
                  {t("conn.save")}
                </button>
              )}
            </div>
          </div>
        );
      }}
    </Modal>
  );
}
