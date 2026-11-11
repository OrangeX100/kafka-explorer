import { useState } from "react";
import { t } from "../../shared/i18n.js";
import { Modal } from "../common/Modal.js";
import type { PartitionSummary } from "../../shared/contracts.js";
import { Select } from "../common/controls.js";

export interface GoToTarget {
  partition: number;
  offset?: number;
  timestamp?: number; // unix ms
}

// GoToDialog: jump to an offset or a timestamp (the classic Go To dialog).
// Returns the anchor; the caller turns it into a browse request
// (startOffset for offset mode, startTimestamp for timestamp mode — the
// backend resolves the first offset at/after the instant).
export function GoToDialog({
  topic,
  partitions,
  defaultPartition,
  onJump,
  onClose,
}: {
  topic: string;
  partitions: PartitionSummary[];
  defaultPartition: number;
  onJump: (target: GoToTarget) => void;
  onClose: () => void;
}) {
  const [partition, setPartition] = useState(defaultPartition);
  const [mode, setMode] = useState<"offset" | "timestamp">("offset");
  const [offset, setOffset] = useState("");
  const [tsValue, setTsValue] = useState("");
  const closeRef = { current: onClose };

  const jump = () => {
    if (mode === "offset") {
      const off = Number(offset);
      if (!Number.isFinite(off) || off < 0) return;
      onJump({ partition, offset: off });
    } else {
      const ms = Date.parse(tsValue);
      if (Number.isNaN(ms)) return;
      onJump({ partition, timestamp: ms });
    }
    closeRef.current();
  };

  return (
    <Modal title={`${t("msg.goto")} — ${topic}`} width={400} onClose={onClose}>
      {(close) => {
        closeRef.current = close;
        return (
          <div className="space-y-2.5">
            <div className="grid grid-cols-2 gap-2.5">
              <label className="block">
                <span className="mb-1 block text-11 text-ink-300">{t("topic.partition")}</span>
                    <Select value={String(partition)} options={partitions.map((p) => ({ value: String(p.id), label: String(p.id) }))} onChange={(v) => setPartition(Number(v))} />
              </label>
              <label className="block">
                <span className="mb-1 block text-11 text-ink-300">{t("msg.gotoMode")}</span>
                    <Select
      value={mode}
      options={[
        { value: "offset", label: t("msg.colOffset") },
        { value: "timestamp", label: t("msg.colTimestamp") },
      ]}
      onChange={(v) => setMode(v as "offset" | "timestamp")}
    />
              </label>
            </div>
            {mode === "offset" ? (
              <label className="block">
                <span className="mb-1 block text-11 text-ink-300">{t("msg.colOffset")}</span>
                <input
                  className="field font-mono"
                  type="number"
                  value={offset}
                  onChange={(e) => setOffset(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && offset !== "" && jump()}
                />
              </label>
            ) : (
              <label className="block">
                <span className="mb-1 block text-11 text-ink-300">{t("msg.colTimestamp")}</span>
                <input
                  className="field"
                  type="datetime-local"
                  value={tsValue}
                  onChange={(e) => setTsValue(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && tsValue !== "" && jump()}
                />
              </label>
            )}
            <div className="mt-3 flex justify-end gap-2 border-t border-ink-700 pt-3">
              <button className="btn" onClick={close}>{t("common.close")}</button>
              <button
                className="btn btn-accent"
                disabled={mode === "offset" ? offset === "" : tsValue === ""}
                onClick={jump}
              >
                {t("msg.gotoGo")}
              </button>
            </div>
          </div>
        );
      }}
    </Modal>
  );
}
