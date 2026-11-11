import { useRef, useState } from "react";
import { Modal } from "../common/Modal.js";
import { topicsApi } from "../../shared/api.js";
import { useToast } from "../../state/stores.js";
import { t } from "../../shared/i18n.js";
import { friendlyError } from "../../shared/api.js";

interface Props {
  connectionId: string;
  onClose: () => void;
  onCreated: () => void;
}

export function CreateTopicDialog({ connectionId, onClose, onCreated }: Props) {
  const [name, setName] = useState("");
  const [partitions, setPartitions] = useState(1);
  const [rf, setRf] = useState(1);
  const toast = useToast();
  const closeRef = useRef<() => void>(() => {});

  const create = async () => {
    try {
      await topicsApi.create({ connectionId, name, partitions, replicationFactor: rf });
      toast.show(name, "ok");
      onCreated();
      closeRef.current();
    } catch (err) {
      toast.show(friendlyError(err), "error");
    }
  };

  return (
    <Modal title={t("topics.create")} width={380} onClose={onClose}>
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
