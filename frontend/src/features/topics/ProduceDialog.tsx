import { useRef, useState } from "react";
import { Modal } from "../common/Modal.js";
import { messagesApi } from "../../shared/api.js";
import { useToast } from "../../state/stores.js";
import { t } from "../../shared/i18n.js";
import { encodeBase64 } from "../../shared/format.js";
import type { PartitionSummary } from "../../shared/contracts.js";
import { friendlyError } from "../../shared/api.js";
import { Select } from "../common/controls.js";

interface Props {
  connectionId: string;
  topic: string;
  partitions: PartitionSummary[];
  onClose: () => void;
}

// ProduceDialog sends one record. Text fields encode to base64 at submit —
// matching the backend contract (WriteOnly, base64 or raw fallback).
export function ProduceDialog({ connectionId, topic, partitions, onClose }: Props) {
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [partition, setPartition] = useState<string>("");
  const [headersText, setHeadersText] = useState("");
  const toast = useToast();
  const closeRef = useRef<() => void>(() => {});

  const parseHeaders = (): { key: string; value: string }[] =>
    headersText
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        const eq = line.indexOf("=");
        return eq < 0
          ? { key: line, value: "" }
          : { key: line.slice(0, eq), value: line.slice(eq + 1) };
      });

  const send = async () => {
    try {
      const headers = parseHeaders().map((h) => ({
        key: h.key,
        value: encodeBase64(new TextEncoder().encode(h.value)),
      }));
      const result = await messagesApi.produce({
        connectionId,
        topic,
        partition: partition === "" ? undefined : Number(partition),
        key: key ? encodeBase64(new TextEncoder().encode(key)) : undefined,
        value: value ? encodeBase64(new TextEncoder().encode(value)) : undefined,
        headers,
      });
      toast.show(t("msg.produceOk", topic, result.partition, result.offset), "ok");
      closeRef.current();
    } catch (err) {
      toast.show(friendlyError(err), "error");
    }
  };

  return (
    <Modal
      title={
        <>
          {t("msg.produce")} — <span className="font-mono">{topic}</span>
        </>
      }
      width={520}
      onClose={onClose}
    >
      {(close) => {
        closeRef.current = close;
        return (
          <>
            <div className="space-y-2.5">
          <label className="block">
            <span className="mb-1 block text-11 text-ink-300">{t("msg.producePartition")}</span>
                <Select
      value={partition}
      options={[{ value: "", label: "—" }, ...partitions.map((p) => ({ value: String(p.id), label: String(p.id) }))]}
      onChange={(v) => setPartition(v)}
    />
          </label>
          <label className="block">
            <span className="mb-1 block text-11 text-ink-300">{t("msg.produceKey")}</span>
            <input className="field font-mono" value={key} onChange={(e) => setKey(e.target.value)} />
          </label>
          <label className="block">
            <span className="mb-1 block text-11 text-ink-300">{t("msg.produceValue")}</span>
            <textarea
              className="field h-40 font-mono"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-11 text-ink-300">{t("msg.produceHeaders")}</span>
            <textarea
              className="field h-16 font-mono"
              value={headersText}
              onChange={(e) => setHeadersText(e.target.value)}
            />
          </label>
        </div>
            <div className="mt-3 flex justify-end gap-2 border-t border-ink-700 pt-3">
              <button className="btn" onClick={close}>
                {t("common.close")}
              </button>
              <button className="btn btn-accent" onClick={() => void send()}>
                <span className="font-medium">{t("msg.produce")}</span>
              </button>
            </div>
          </>
        );
      }}
    </Modal>
  );
}
