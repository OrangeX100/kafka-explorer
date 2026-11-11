import { useRef, useState } from "react";
import { generateApi } from "../../shared/api.js";
import { useToast } from "../../state/stores.js";
import { t } from "../../shared/i18n.js";
import { Modal } from "../common/Modal.js";
import type { PartitionSummary } from "../../shared/contracts.js";
import { friendlyError } from "../../shared/api.js";
import { Select } from "../common/controls.js";

// GenerateDialog: batch-produce synthetic messages with a Go template.
export function GenerateDialog({
  connectionId,
  topic,
  onClose,
}: {
  connectionId: string;
  topic: string;
  onClose: () => void;
}) {
  const [count, setCount] = useState(100);
  const [keyPrefix, setKeyPrefix] = useState("");
  const [template, setTemplate] = useState(
    `{"id":{{.Index}},"ts":{{.Timestamp}},"payload":"sample {{.Index}}"}`
  );
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const closeRef = useRef<() => void>(() => {});

  const run = async () => {
    setBusy(true);
    try {
      const result = await generateApi.generate({ connectionId, topic, count, format: "json", keyPrefix: keyPrefix || undefined, template });
      toast.show(t("gen.ok", result.produced, topic, result.firstOffset, result.elapsedMs), "ok");
      closeRef.current();
    } catch (err) {
      toast.show(friendlyError(err), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`${t("gen.title")} — ${topic}`} width={520} onClose={onClose}>
      {(close) => {
        closeRef.current = close;
        return (
          <div className="space-y-2.5">
            <div className="grid grid-cols-2 gap-2.5">
              <label className="block">
                <span className="mb-1 block text-11 text-ink-300">{t("gen.count")}</span>
                <input className="field" type="number" min={1} max={100000} value={count} onChange={(e) => setCount(Number(e.target.value))} />
              </label>
              <label className="block">
                <span className="mb-1 block text-11 text-ink-300">{t("gen.keyPrefix")}</span>
                <input className="field font-mono" value={keyPrefix} onChange={(e) => setKeyPrefix(e.target.value)} />
              </label>
            </div>
            <label className="block">
              <span className="mb-1 block text-11 text-ink-300">{t("gen.template")}</span>
              <textarea className="field h-28 font-mono" value={template} onChange={(e) => setTemplate(e.target.value)} />
              <span className="mt-1 block text-10 text-ink-400">{t("gen.templateHint")}</span>
            </label>
            <div className="mt-3 flex justify-end gap-2 border-t border-ink-700 pt-3">
              <button className="btn" onClick={close}>{t("common.close")}</button>
              <button className="btn btn-accent" disabled={busy} onClick={() => void run()}>{t("gen.run")}</button>
            </div>
          </div>
        );
      }}
    </Modal>
  );
}

// ExportDialog: export a partition window as JSONL/CSV into the clipboard.
export function ExportDialog({
  connectionId,
  topic,
  partitions,
  defaultPartition,
  onClose,
}: {
  connectionId: string;
  topic: string;
  partitions: PartitionSummary[];
  defaultPartition: number;
  onClose: () => void;
}) {
  const [partition, setPartition] = useState(defaultPartition);
  const [from, setFrom] = useState("0");
  const [to, setTo] = useState("");
  const [format, setFormat] = useState("jsonl");
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const closeRef = useRef<() => void>(() => {});

  const run = async () => {
    setBusy(true);
    try {
      const text = await generateApi.export({
        connectionId,
        topic,
        partition,
        from: Number(from) || 0,
        to: to === "" ? undefined : Number(to),
        format,
      });
      try {
        await navigator.clipboard.writeText(text);
        toast.show(t("msg.exportOk", text.length), "ok");
      } catch {
        toast.show(t("msg.copyFail"), "error");
      }
      closeRef.current();
    } catch (err) {
      toast.show(friendlyError(err), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`${t("msg.export")} — ${topic}`} width={440} onClose={onClose}>
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
                <span className="mb-1 block text-11 text-ink-300">{t("gen.format")}</span>
                    <Select
      value={format}
      options={[
        { value: "jsonl", label: "JSONL" },
        { value: "csv", label: "CSV" },
      ]}
      onChange={(v) => setFormat(v)}
    />
              </label>
              <label className="block">
                <span className="mb-1 block text-11 text-ink-300">{t("msg.colOffset")} ≥</span>
                <input className="field font-mono" type="number" value={from} onChange={(e) => setFrom(e.target.value)} />
              </label>
              <label className="block">
                <span className="mb-1 block text-11 text-ink-300">{t("msg.colOffset")} ≤</span>
                <input className="field font-mono" type="number" placeholder="∞" value={to} onChange={(e) => setTo(e.target.value)} />
              </label>
            </div>
            <div className="mt-3 flex justify-end gap-2 border-t border-ink-700 pt-3">
              <button className="btn" onClick={close}>{t("common.close")}</button>
              <button className="btn btn-accent" disabled={busy} onClick={() => void run()}>{t("msg.export")}</button>
            </div>
          </div>
        );
      }}
    </Modal>
  );
}

// ImportDialog: paste JSONL records and produce them.
export function ImportDialog({
  connectionId,
  topic,
  onClose,
}: {
  connectionId: string;
  topic: string;
  onClose: () => void;
}) {
  const [payload, setPayload] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const closeRef = useRef<() => void>(() => {});

  const run = async () => {
    setBusy(true);
    try {
      const result = await generateApi.import({ connectionId, topic, count: 0, format: "jsonl", template: payload });
      toast.show(t("msg.importOk", result.produced), "ok");
      closeRef.current();
    } catch (err) {
      toast.show(friendlyError(err), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`${t("msg.import")} — ${topic}`} width={560} onClose={onClose}>
      {(close) => {
        closeRef.current = close;
        return (
          <div className="space-y-2.5">
            <span className="block text-11 text-ink-400">{t("msg.importHint")}</span>
            <textarea className="field h-48 font-mono" value={payload} onChange={(e) => setPayload(e.target.value)} />
            <div className="mt-3 flex justify-end gap-2 border-t border-ink-700 pt-3">
              <button className="btn" onClick={close}>{t("common.close")}</button>
              <button className="btn btn-accent" disabled={busy || !payload.trim()} onClick={() => void run()}>
                {t("msg.import")}
              </button>
            </div>
          </div>
        );
      }}
    </Modal>
  );
}
