import { useRef, useState } from "react";
import { Modal } from "../common/Modal.js";
import { topicsApi } from "../../shared/api.js";
import { useToast } from "../../state/stores.js";
import { t } from "../../shared/i18n.js";
import { friendlyError } from "../../shared/api.js";
import { Select } from "../common/controls.js";
import { configName, configDesc } from "../../shared/configLocale.js";

interface Props {
  connectionId: string;
  onClose: () => void;
  onCreated: () => void;
}

// Presets for the config editor: the handful of topic configs people set
// at creation time (retention / cleanup / min-ISR / compression). The full
// dictionary stays reachable in the config page after creation.
const CONFIG_PRESETS: { key: string; sample: string }[] = [
  { key: "retention.ms", sample: "604800000" },
  { key: "cleanup.policy", sample: "delete" },
  { key: "compression.type", sample: "producer" },
  { key: "min.insync.replicas", sample: "1" },
  { key: "retention.bytes", sample: "-1" },
  { key: "max.message.bytes", sample: "1048588" },
];

export function CreateTopicDialog({ connectionId, onClose, onCreated }: Props) {
  const [name, setName] = useState("");
  const [partitions, setPartitions] = useState(1);
  const [rf, setRf] = useState(1);
  // configs: creation-time overrides. Empty VALUES are skipped (a blank
  // entry is a UI row, not an intent to set an empty config).
  const [configs, setConfigs] = useState<{ key: string; value: string }[]>([]);
  const toast = useToast();
  const closeRef = useRef<() => void>(() => {});

  const addConfig = (key = "", value = "") =>
    setConfigs((rows) => (rows.some((r) => r.key === key && key !== "") ? rows : [...rows, { key, value }]));

  const pickPreset = (key: string) => {
    if (!key) return;
    const preset = CONFIG_PRESETS.find((p) => p.key === key);
    addConfig(key, preset?.sample ?? "");
  };

  const create = async () => {
    const configMap: Record<string, string> = {};
    for (const r of configs) {
      if (r.key.trim() !== "" && r.value.trim() !== "") configMap[r.key.trim()] = r.value.trim();
    }
    try {
      await topicsApi.create({
        connectionId,
        name,
        partitions,
        replicationFactor: rf,
        configs: Object.keys(configMap).length > 0 ? configMap : undefined,
      });
      toast.show(name, "ok");
      onCreated();
      closeRef.current();
    } catch (err) {
      toast.show(friendlyError(err), "error");
    }
  };

  return (
    <Modal title={t("topics.create")} width={460} onClose={onClose}>
      {(close) => {
        closeRef.current = close;
        return (
          <>
            <div className="space-y-2.5">
              <label className="block">
                <span className="mb-1 block text-11 text-ink-300">{t("topic.name")}</span>
                <input className="field font-mono" value={name} onChange={(e) => setName(e.target.value)} />
              </label>
              <div className="grid grid-cols-2 gap-2.5">
                <label className="block">
                  <span className="mb-1 block text-11 text-ink-300">{t("topic.partitions")}</span>
                  <input
                    className="field"
                    type="number"
                    min={1}
                    value={partitions}
                    onChange={(e) => setPartitions(Number(e.target.value))}
                  />
                  <span className="mt-1 block text-10 leading-relaxed text-ink-400">{t("topic.partitionsHint")}</span>
                </label>
                <label className="block">
                  <span className="mb-1 block text-11 text-ink-300">{t("topic.rf")}</span>
                  <input
                    className="field"
                    type="number"
                    min={1}
                    value={rf}
                    onChange={(e) => setRf(Number(e.target.value))}
                  />
                  <span className="mt-1 block text-10 leading-relaxed text-ink-400">{t("topic.rfHint")}</span>
                </label>
              </div>
              {/* creation-time config overrides: preset-driven rows, free
                  k/v editing, blanks skipped at submit */}
              <div>
                <div className="mb-1 flex items-center gap-2">
                  <span className="block text-11 text-ink-300">{t("topic.configs")}</span>
                  <div className="flex-1" />
                  <div className="w-44">
                    <Select
                      value=""
                      options={[{ value: "", label: t("topic.configPreset") }, ...CONFIG_PRESETS.map((p) => ({ value: p.key, label: configName(p.key) }))]}
                      onChange={pickPreset}
                    />
                  </div>
                </div>
                {configs.length > 0 && (
                  <div className="space-y-1">
                    {configs.map((row, i) => (
                      <div key={i} className="flex items-center gap-1.5">
                        <input
                          className="field !w-44 !py-1 font-mono"
                          placeholder={t("topic.configKey")}
                          value={row.key}
                          onChange={(e) =>
                            setConfigs((rows) => rows.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)))
                          }
                        />
                        <input
                          className="field min-w-0 flex-1 !py-1 font-mono"
                          placeholder={t("topic.configValue")}
                          value={row.value}
                          onChange={(e) =>
                            setConfigs((rows) => rows.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))
                          }
                        />
                        <button
                          className="btn !px-1.5 !py-0.5 text-ink-400"
                          title={t("conn.delete")}
                          onClick={() => setConfigs((rows) => rows.filter((_, j) => j !== i))}
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                {configs.some((r) => r.key.trim() !== "") && (
                  <div className="mt-1 space-y-0.5 text-10 text-ink-400">
                    {configs
                      .filter((r) => configDesc(r.key))
                      .map((r, i) => (
                        <div key={i}>{`${r.key} — ${configDesc(r.key)}`}</div>
                      ))}
                  </div>
                )}
              </div>
            </div>
            <div className="mt-3 flex justify-end gap-2 border-t border-ink-700 pt-3">
              <button className="btn" onClick={close}>
                {t("conn.cancel")}
              </button>
              <button className="btn btn-accent" disabled={!name} onClick={() => void create()}>
                {t("topics.createOk")}
              </button>
            </div>
          </>
        );
      }}
    </Modal>
  );
}
