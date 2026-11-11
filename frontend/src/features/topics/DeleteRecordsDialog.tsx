import { useRef, useState } from "react";
import { Modal } from "../common/Modal.js";
import { messagesApi } from "../../shared/api.js";
import { useToast } from "../../state/stores.js";
import { t } from "../../shared/i18n.js";
import type { PartitionSummary } from "../../shared/contracts.js";
import { friendlyError } from "../../shared/api.js";
import { Select } from "../common/controls.js";

interface Props {
  connectionId: string;
  topic: string;
  partitions: PartitionSummary[];
  defaultPartition: number;
  onClose: () => void;
}

// DeleteRecordsDialog: truncates records before an offset. Irreversible, so
// the dialog demands the partition explicitly and shows the numeric target.
export function DeleteRecordsDialog({ connectionId, topic, partitions, defaultPartition, onClose }: Props) {
  const [partition, setPartition] = useState(defaultPartition);
  const [offset, setOffset] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const closeRef = useRef<() => void>(() => {});

  const run = async () => {
    const off = Number(offset);
    if (!Number.isFinite(off) || off < 0) {
      toast.show(t("error.invalid"), "error");
      return;
    }
    setBusy(true);
    try {
      await messagesApi.deleteRecords({
        connectionId,
        topic,
        offset: off,
        partitions: [partition],
      });
      toast.show(`${topic}-${partition}: < ${off}`, "ok");
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
      width={420}
      title={
        <>
          {t("msg.deleteRecords")} — <span className="font-mono">{topic}</span>
        </>
      }
      onClose={onClose}
    >
      {(close) => {
        closeRef.current = close;
        return (
          <>
            <div className="space-y-2.5">
          <label className="block">
            <span className="mb-1 block text-11 text-ink-300">{t("topic.partition")}</span>
                <Select
      value={String(partition)}
      options={partitions.map((p) => ({ value: String(p.id), label: `${p.id} (${t("msg.colOffset")} 0–${p.logEnd})` }))}
      onChange={(v) => setPartition(Number(v))}
    />
          </label>
          <label className="block">
            <span className="mb-1 block text-11 text-ink-300">{t("msg.colOffset")} &lt;</span>
            <input
              className="field font-mono"
              type="number"
              value={offset}
              onChange={(e) => setOffset(e.target.value)}
            />
          </label>
          <div className="rounded border border-danger/40 bg-danger/10 px-2.5 py-2 text-11 text-ink-100">
            {t("msg.deleteRecordsHint", offset || "?")}
          </div>
        </div>
            <div className="mt-3 flex justify-end gap-2 border-t border-ink-700 pt-3">
              <button className="btn" onClick={close}>
                {t("common.close")}
              </button>
              <button className="btn btn-danger" disabled={busy || offset === ""} onClick={() => void run()}>
                {t("msg.deleteRecordsConfirm")}
              </button>
            </div>
          </>
        );
      }}
    </Modal>
  );
}
