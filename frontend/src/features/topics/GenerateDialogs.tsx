import { useEffect, useRef, useState } from "react";
import { Events } from "@wailsio/runtime";
import { generateApi, systemApi } from "../../shared/api.js";
import { useToast } from "../../state/stores.js";
import { t } from "../../shared/i18n.js";
import { Modal } from "../common/Modal.js";
import type { PartitionSummary } from "../../shared/contracts.js";
import type { ImportFileResult } from "../../shared/contracts-admin.js";
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

// ExportDialog: export a window as JSONL/CSV — to the clipboard or to a
// file, single partition or all. Schema-aware mode adds the decoder's
// rendering (decodedValue) so Avro/Protobuf payloads leave readable.
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
  const [decoded, setDecoded] = useState(true);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const closeRef = useRef<() => void>(() => {});

  const input = () => ({
    connectionId,
    topic,
    partition,
    from: Number(from) || 0,
    to: to === "" ? undefined : Number(to),
    format,
    decoded: format === "jsonl" && decoded,
  });

  const copy = async () => {
    setBusy(true);
    try {
      const text = await generateApi.export(input());
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

  const save = async () => {
    const ext = format === "csv" ? "csv" : "jsonl";
    const path = await systemApi.pickSaveFile(t("msg.exportSaveTitle"), `${topic}.${ext}`, `*.${ext}`);
    if (!path) return; // cancelled
    setBusy(true);
    try {
      const count = await generateApi.exportToFile(input(), path);
      toast.show(t("msg.exportFileOk", String(count), path), "ok");
      closeRef.current();
    } catch (err) {
      toast.show(friendlyError(err), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`${t("msg.export")} — ${topic}`} width={460} onClose={onClose}>
      {(close) => {
        closeRef.current = close;
        return (
          <div className="space-y-2.5">
            <div className="grid grid-cols-2 gap-2.5">
              <label className="block">
                <span className="mb-1 block text-11 text-ink-300">{t("topic.partition")}</span>
                <Select
                  value={String(partition)}
                  options={[
                    { value: "-1", label: t("msg.exportAllPartitions") },
                    ...partitions.map((p) => ({ value: String(p.id), label: String(p.id) })),
                  ]}
                  onChange={(v) => setPartition(Number(v))}
                />
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
            {format === "jsonl" && (
              <label className="flex items-center gap-1.5 text-11 text-ink-300">
                <input type="checkbox" checked={decoded} onChange={(e) => setDecoded(e.target.checked)} />
                {t("msg.exportDecoded")}
                <span className="text-10 text-ink-400">{t("msg.exportDecodedHint")}</span>
              </label>
            )}
            <div className="mt-3 flex items-center gap-2 border-t border-ink-700 pt-3">
              <button className="btn" onClick={close}>{t("common.close")}</button>
              <div className="flex-1" />
              <button className="btn" disabled={busy} onClick={() => void copy()}>{t("msg.exportCopy")}</button>
              <button className="btn btn-accent" disabled={busy} onClick={() => void save()}>{t("msg.exportSave")}</button>
            </div>
          </div>
        );
      }}
    </Modal>
  );
}

// ImportDialog: produce JSONL records — pasted inline or loaded from a
// file. File imports stream progress through the io:import:progress event
// (done/failed/total) and report per-line failures afterwards; the run is
// best-effort: good lines land, bad lines are listed with line numbers.
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
  const [progress, setProgress] = useState<{ done: number; failed: number; total: number } | null>(null);
  const [result, setResult] = useState<ImportFileResult | null>(null);
  const toast = useToast();
  const closeRef = useRef<() => void>(() => {});

  // Progress rides the app event bus while a FILE import runs; the paste
  // path is fast enough to stay a single call.
  useEffect(() => {
    const off = Events.On("io:import:progress", (ev: unknown) => {
      const data = (ev as { data?: { done: number; failed: number; total: number } }).data;
      if (data) setProgress(data);
    });
    return () => off();
  }, []);

  const run = async () => {
    setBusy(true);
    try {
      const r = await generateApi.import({ connectionId, topic, count: 0, format: "jsonl", template: payload });
      toast.show(t("msg.importOk", r.produced), "ok");
      closeRef.current();
    } catch (err) {
      toast.show(friendlyError(err), "error");
    } finally {
      setBusy(false);
    }
  };

  const runFile = async () => {
    const path = await systemApi.pickOpenFile(t("msg.importPickFile"), "*.jsonl;*.txt;*.json");
    if (!path) return; // cancelled
    setBusy(true);
    setResult(null);
    setProgress({ done: 0, failed: 0, total: 0 });
    try {
      const r = await generateApi.importFromFile({ connectionId, topic, path });
      setResult(r);
      if (r.failed === 0) {
        toast.show(t("msg.importFileOk", r.produced), "ok");
      } else {
        toast.show(t("msg.importFilePartial", r.produced, r.failed), "error");
      }
    } catch (err) {
      toast.show(friendlyError(err), "error");
    } finally {
      setProgress(null);
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
            <textarea className="field h-40 font-mono" value={payload} onChange={(e) => setPayload(e.target.value)} />
            <div className="flex items-center gap-2">
              <button className="btn" disabled={busy} onClick={() => void runFile()}>
                {t("msg.importFromFile")}
              </button>
              <span className="text-10 text-ink-400">{t("msg.importFileHint")}</span>
              <div className="flex-1" />
              {progress && (
                <span className="text-11 text-ink-300">
                  {t("msg.importProgress", progress.done, progress.failed, progress.total)}
                </span>
              )}
            </div>
            {result && (
              <div className="rounded border border-ink-700 bg-ink-900 px-2.5 py-2 text-11">
                <div className="text-ink-200">
                  {t("msg.importResult", result.produced, result.failed, result.elapsedMs)}
                </div>
                {(result.failedLines ?? []).slice(0, 5).map((f: { line: number; error: string }) => (
                  <div key={f.line} className="text-danger selectable">
                    {t("msg.importFailedLine", f.line, f.error)}
                  </div>
                ))}
                {(result.failedLines?.length ?? 0) > 5 && (
                  <div className="text-ink-400">{t("msg.importMoreFailed", result.failedLines!.length - 5)}</div>
                )}
              </div>
            )}
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
