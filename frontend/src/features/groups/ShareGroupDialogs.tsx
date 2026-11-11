import { useState } from "react";
import { groupsApi } from "../../shared/api.js";
import { useToast } from "../../state/stores.js";
import { t } from "../../shared/i18n.js";
import { formatNumber } from "../../shared/format.js";
import { Modal } from "../common/Modal.js";
import { friendlyError } from "../../shared/api.js";
// ShareOffsetDialog: single-partition start-offset edit. Show the log end as
// the upper reference and offer quick fill; the group must be Empty or the
// broker rejects the alter.
export function ShareOffsetDialog({
  connectionId,
  group,
  target,
  warning,
  onClose,
  onApplied,
}: {
  connectionId: string;
  group: string;
  target: { topic: string; partition: number; startOffset: number };
  warning?: string;
  onClose: () => void;
  onApplied: () => void;
}) {
  const [value, setValue] = useState(String(target.startOffset));
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const apply = () => {
    const offset = Number(value);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      toast.show(t("share.invalidOffset"), "error");
      return;
    }
    setBusy(true);
    void groupsApi
      .alterShareGroupOffset({ connectionId, group, topic: target.topic, partition: target.partition, startOffset: offset })
      .then(() => {
        toast.show(t("share.alterOk"), "ok");
        onApplied();
        onClose();
      })
      .catch((e) => toast.show(friendlyError(e), "error"))
      .finally(() => setBusy(false));
  };

  return (
    <Modal title={`${t("share.editStartOffset")} — ${group}`} onClose={onClose}>
      {(close) => (
      <div className="flex flex-col gap-2.5 text-xs">
        <div className="font-mono text-ink-200">
          {target.topic}-{target.partition}
        </div>
        {warning && <div className="rounded border border-warn/40 bg-warn/10 px-2 py-1.5 text-warn">{warning}</div>}
        <label className="flex flex-col gap-1">
          <span className="text-ink-300">{t("share.startOffsetLabel")}</span>
          <input
            className="input font-mono"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !busy) apply();
            }}
            autoFocus
          />
          <span className="text-10 text-ink-400">
            {t("share.currentStart")}: {formatNumber(target.startOffset)}
          </span>
        </label>
        <div className="flex gap-1.5">
          <button className="btn" onClick={() => setValue("0")}>
            0
          </button>
          <button className="btn" onClick={() => setValue(String(target.startOffset))}>
            {t("share.revertCurrent")}
          </button>
        </div>
        <p className="text-11 text-ink-400">{t("share.alterHint")}</p>
        <div className="mt-1 flex justify-end gap-2">
          <button className="btn" onClick={close}>
            {t("common.cancel")}
          </button>
          <button className="btn btn-danger" disabled={busy} onClick={apply}>
            {t("common.apply")}
          </button>
        </div>
      </div>
      )}
    </Modal>
  );
}

// ClearShareOffsetsDialog: per-topic selection of which delivery progress to
// forget (DeleteShareGroupOffsets is per-topic on the wire).
export function ClearShareOffsetsDialog({
  connectionId,
  group,
  topics,
  onClose,
  onApplied,
}: {
  connectionId: string;
  group: string;
  topics: string[];
  onClose: () => void;
  onApplied: () => void;
}) {
  const [selected, setSelected] = useState<string[]>(topics);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const toggle = (topic: string) => {
    setSelected((s) => (s.includes(topic) ? s.filter((x) => x !== topic) : [...s, topic]));
  };

  const apply = () => {
    if (selected.length === 0) return;
    setBusy(true);
    void groupsApi
      .deleteShareGroupOffsets(connectionId, group, selected)
      .then(() => {
        toast.show(t("share.clearOk"), "ok");
        onApplied();
        onClose();
      })
      .catch((e) => toast.show(friendlyError(e), "error"))
      .finally(() => setBusy(false));
  };

  return (
    <Modal title={`${t("share.clearOffsets")} — ${group}`} danger onClose={onClose}>
      {(close) => (
      <div className="flex flex-col gap-2.5 text-xs">
        <p className="text-ink-300">{t("share.clearHint")}</p>
        <div className="flex max-h-52 flex-col gap-1 overflow-y-auto">
          {topics.map((topic) => (
            <label key={topic} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 hover:bg-ink-800">
              <input
                type="checkbox"
                checked={selected.includes(topic)}
                onChange={() => toggle(topic)}
                className="accent-[var(--ke-accent)]"
              />
              <span className="font-mono">{topic}</span>
            </label>
          ))}
          {topics.length === 0 && <span className="text-ink-400">{t("groups.empty")}</span>}
        </div>
        <div className="mt-1 flex justify-end gap-2">
          <button className="btn" onClick={close}>
            {t("common.cancel")}
          </button>
          <button className="btn btn-danger" disabled={busy || selected.length === 0} onClick={apply}>
            {t("common.apply")}
          </button>
        </div>
      </div>
      )}
    </Modal>
  );
}
