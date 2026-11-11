import { useRef, useState } from "react";
import { Modal } from "../common/Modal.js";
import { groupsApi } from "../../shared/api.js";
import { useToast } from "../../state/stores.js";
import { t } from "../../shared/i18n.js";
import { formatNumber } from "../../shared/format.js";
import type { OffsetResetPlan } from "../../shared/contracts.js";
import { friendlyError } from "../../shared/api.js";
import { Select } from "../common/controls.js";

interface Props {
  connectionId: string;
  group: string;
  topics: string[];
  onClose: () => void;
  onApplied: () => void;
  // Prefill (per-partition edit): opens with absolute mode locked to one
  // partition and the row's current committed offset.
  initialMode?: OffsetResetTargetMode;
  initialPartition?: number;
  initialAbsolute?: number;
  // Shown when the group has active members (broker may reject/overwrite).
  warning?: string;
}

// ResetOffsetDialog: preview-then-apply. DryRun first (backend returns the
// per-partition plan without committing); only the explicit apply call
// commits. This ordering is mandatory — offset reset is irreversible.
export function ResetOffsetDialog({
  connectionId,
  group,
  topics,
  onClose,
  onApplied,
  initialMode,
  initialPartition,
  initialAbsolute,
  warning,
}: Props) {
  const [topic, setTopic] = useState(topics[0] ?? "");
  const [mode, setMode] = useState<OffsetResetTargetMode>(initialMode ?? "earliest");
  const [absolute, setAbsolute] = useState(initialAbsolute !== undefined ? String(initialAbsolute) : "");
  const [timestamp, setTimestamp] = useState("");
  const [partitionsText, setPartitionsText] = useState(initialPartition !== undefined ? String(initialPartition) : "");
  const [plan, setPlan] = useState<OffsetResetPlan[] | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const closeRef = useRef<() => void>(() => {});

  const buildTarget = (dryRun: boolean) => {
    const partitions = partitionsText
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number);
    return {
      connectionId,
      group,
      topic,
      partitions,
      mode,
      absolute: mode === "absolute" ? Number(absolute) : undefined,
      timestamp: mode === "timestamp" ? Date.parse(timestamp) || undefined : undefined,
      dryRun,
    };
  };

  const preview = async () => {
    setBusy(true);
    try {
      setPlan(await groupsApi.resetOffset(buildTarget(true)));
    } catch (err) {
      toast.show(friendlyError(err), "error");
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    setBusy(true);
    try {
      const result = await groupsApi.resetOffset(buildTarget(false));
      toast.show(t("groups.resetDone", result.length), "ok");
      onApplied();
      closeRef.current();
    } catch (err) {
      toast.show(friendlyError(err), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      danger
      width={520}
      title={
        <>
          {t("groups.reset")} — <span className="font-mono">{group}</span>
        </>
      }
      onClose={onClose}
    >
      {(close) => {
        closeRef.current = close;
        return (
          <>
            <div className="space-y-2.5">
            {warning && (
              <div className="rounded border border-warn/50 bg-warn/10 px-2.5 py-2 text-11 leading-relaxed text-ink-200">
                {warning}
              </div>
            )}
          <label className="block">
            <span className="mb-1 block text-11 text-ink-300">{t("groups.colTopic")}</span>
                <Select className="font-mono" value={topic} options={topics.map((tp) => ({ value: tp, label: tp }))} onChange={(v) => setTopic(v)} />
          </label>
          <div className="grid grid-cols-2 gap-2.5">
            <label className="block">
              <span className="mb-1 block text-11 text-ink-300">{t("groups.resetMode")}</span>
                  <Select
      value={mode}
      options={[
        { value: "earliest", label: t("groups.modeEarliest") },
        { value: "latest", label: t("groups.modeLatest") },
        { value: "absolute", label: t("groups.modeAbsolute") },
        { value: "timestamp", label: t("groups.modeTimestamp") },
      ]}
      onChange={(v) => setMode(v as OffsetResetTargetMode)}
    />
            </label>
            <label className="block">
              <span className="mb-1 block text-11 text-ink-300">{t("topic.partition")}</span>
              <input
                className="field font-mono"
                placeholder={t("groups.resetPartitionHint")}
                value={partitionsText}
                onChange={(e) => setPartitionsText(e.target.value)}
              />
            </label>
          </div>
          {mode === "absolute" && (
            <label className="block">
              <span className="mb-1 block text-11 text-ink-300">{t("groups.modeAbsolute")}</span>
              <input
                className="field font-mono"
                type="number"
                value={absolute}
                onChange={(e) => setAbsolute(e.target.value)}
              />
            </label>
          )}
          {mode === "timestamp" && (
            <label className="block">
              <span className="mb-1 block text-11 text-ink-300">{t("groups.modeTimestamp")}</span>
              <input
                className="field"
                type="datetime-local"
                value={timestamp}
                onChange={(e) => setTimestamp(e.target.value)}
              />
            </label>
          )}

          {plan && (
            <div className="max-h-48 overflow-auto rounded border border-ink-700">
              <table className="w-full text-11">
                <thead>
                  <tr>
                    <th className="table-head px-2 py-1">{t("groups.resetColPartition")}</th>
                    <th className="table-head px-2 py-1">{t("groups.resetColCommitted")}</th>
                    <th className="table-head px-2 py-1">{t("groups.resetColNew")}</th>
                    <th className="table-head px-2 py-1">{t("groups.resetColLogEnd")}</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.map((r) => (
                    <tr key={r.partition} className="border-b border-ink-800 font-mono">
                      <td className="px-2 py-1">{r.partition}</td>
                      <td className="px-2 py-1 text-ink-300">{r.committed < 0 ? "∅" : formatNumber(r.committed)}</td>
                      <td className="px-2 py-1 text-warn">{formatNumber(r.newOffset)}</td>
                      <td className="px-2 py-1 text-ink-300">{formatNumber(r.logEnd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
            <div className="mt-3 flex justify-end gap-2 border-t border-ink-700 pt-3">
              <button className="btn" onClick={close}>
                {t("common.close")}
              </button>
              <button className="btn" disabled={busy || !topic} onClick={() => void preview()}>
                {t("groups.resetDryRun")}
              </button>
              <button className="btn btn-danger" disabled={busy || !plan || plan.length === 0} onClick={() => void apply()}>
                {t("groups.resetApply")}
              </button>
            </div>
          </>
        );
      }}
    </Modal>
  );
}

type OffsetResetTargetMode = "earliest" | "latest" | "absolute" | "timestamp";
