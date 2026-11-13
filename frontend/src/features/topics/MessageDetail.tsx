import { useRef, useState } from "react";
import { BookMarked, Copy, X } from "lucide-react";
import { JsonView } from "./JsonView.js";
import { Modal } from "../common/Modal.js";
import { t } from "../../shared/i18n.js";
import { formatBytes, formatTime, prettyJson, toHex, toText } from "../../shared/format.js";
import { detectFormat, smartText } from "../../shared/binary.js";
import { useContextMenu } from "../common/ContextMenu.js";
import { useCopy } from "../../shared/useCopy.js";
import { registryApi, friendlyError } from "../../shared/api.js";
import { useToast } from "../../state/stores.js";
import type { LocalSchema } from "../../shared/contracts-admin.js";
import type { Message } from "../../shared/contracts.js";

export type ViewMode = "json" | "text" | "hex" | "decoded";

// MessageDetail: the bottom pane of the messages view — metadata line,
// headers strip, view-mode switch and the payload rendering. The JSON/text/
// hex switch ALWAYS re-renders from the raw bytes; decoded content (Schema
// Registry Avro / pretty JSON) is its own tab so switching can never look
// dead. The ops-row 已解码 checkbox controls whether the browse request
// decodes at all.
const DETAIL_DEFAULT_HEIGHT = 256;
const DETAIL_MIN_HEIGHT = 140;

export function MessageDetail({
  message,
  mode,
  setMode,
  decodedOverride,
  onClose,
  height,
  onHeightChange,
}: {
  message: Message;
  mode: ViewMode;
  setMode: (m: ViewMode) => void;
  // Frontend-deterministic decode (internal topics): rendered as the
  // decoded tab exactly like a registry-backed Avro decode would be.
  decodedOverride?: { format: string; text: string };
  // Collapse the pane (parent clears the selection).
  onClose?: () => void;
  // Resizable height (parent persists it in localStorage).
  height?: number;
  onHeightChange?: (h: number) => void;
}) {
  const decoded = decodedOverride
    ? { format: decodedOverride.format, text: decodedOverride.text, error: "" }
    : message.decoded;
  const decodedOk = Boolean(decoded && !decoded.error && decoded.text);
  // Confluent-wrapped payload with no working decode: surface a guided
  // hint (schema id + what to configure) instead of dead hex silence.
  const valueBytes = base64Of(message.value ?? "");
  const fmt = detectFormat(valueBytes);
  // The backend returns format:"text" as a non-decode fallback — only a
  // real decode (different format, no error) counts as decoded.
  // The backend also returns format:"json" for plain-JSON payloads (pretty
  // already shown by the JSON tab) — both "text" and "json" are NON-decodes.
  const realDecode = decodedOk && decoded!.format !== "text" && decoded!.format !== "json";
  const confluentHint =
    !realDecode && fmt?.kind === "confluent"
      ? t("decode.confluentHint", fmt.schemaId ?? 0)
      : null;
  // (decoded-tab registration happens below, after tabs[] is built)
  const copy = useCopy();
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);
  const { open: openCtx, menu: ctxMenu } = useContextMenu();
  // Right-click menus follow the current view mode's content: the pretty
  // copy is skipped in hex mode where the bytes ARE the content.
  const payloadMenu = (e: React.MouseEvent) =>
    openCtx(e, [
      { label: t("ctx.copyValue"), onSelect: () => copy(body) },
      ...(mode === "hex"
        ? []
        : [{ label: t("ctx.copyJsonPretty"), onSelect: () => copy(prettyJson(toText(message.value))) }]),
      { label: t("ctx.copyHex"), onSelect: () => copy(toHex(message.value)) },
    ]);
  const metaMenu = (e: React.MouseEvent) =>
    openCtx(e, [
      { label: t("ctx.copyPartition"), onSelect: () => copy(String(message.partition)) },
      { label: t("ctx.copyOffset"), onSelect: () => copy(String(message.offset)) },
      { label: t("ctx.copyTimestamp"), onSelect: () => copy(formatTime(message.timestamp)) },
    ]);
  const tabs: { v: ViewMode; label: string }[] = [
    { v: "text", label: t("msg.viewString") },
    { v: "json", label: t("msg.viewJson") },
    { v: "hex", label: t("msg.viewHex") },
  ];
  // Text and json "decodes" are not decodes: text duplicated the 文本 tab
  // as a lowercase "text" first tab, and a plain JSON payload's decoded
  // form is identical to the raw JSON tab. Only real decodes (e.g. Avro)
  // get their own tab.
  if (decodedOk && decoded!.format !== "text" && decoded!.format !== "json") {
    tabs.unshift({ v: "decoded", label: decoded!.format || t("msg.viewDecoded") });
  }
  if (confluentHint) {
    tabs.push({ v: "decoded", label: t("msg.viewDecoded") });
  }
  const body =
    mode === "decoded" && confluentHint
      ? confluentHint
      : mode === "decoded" && realDecode
        ? decoded!.text
        : renderRaw(message, mode);

  return (
    <div
      className="flex flex-col border-t border-ink-700 bg-ink-900"
      style={{ height: height ?? DETAIL_DEFAULT_HEIGHT }}
    >
      {/* drag handle: up/down resize; double-click restores the default */}
      <div
        className="h-1.5 w-full flex-none cursor-ns-resize bg-ink-800 transition-colors hover:bg-accent/40"
        title={t("msg.detailResize")}
        onPointerDown={(e) => {
          (e.currentTarget as Element).setPointerCapture(e.pointerId);
          dragRef.current = { startY: e.clientY, startH: height ?? DETAIL_DEFAULT_HEIGHT };
        }}
        onPointerMove={(e) => {
          const d = dragRef.current;
          if (!d || !onHeightChange) return;
          const max = Math.max(DETAIL_MIN_HEIGHT + 60, window.innerHeight - 200);
          const h = Math.min(Math.max(d.startH + (d.startY - e.clientY), DETAIL_MIN_HEIGHT), max);
          onHeightChange(h);
        }}
        onPointerUp={(e) => {
          dragRef.current = null;
          try {
            (e.currentTarget as Element).releasePointerCapture(e.pointerId);
          } catch {
            /* released already */
          }
        }}
        onDoubleClick={() => onHeightChange?.(DETAIL_DEFAULT_HEIGHT)}
      />
      <div className="flex items-center gap-2 border-b border-ink-700 px-3 py-1.5">
        <span
          className="text-11 text-ink-300"
          onContextMenu={metaMenu}
        >
          {t("msg.colPartition")} {message.partition} · {t("msg.colOffset")}{" "}
          {new Intl.NumberFormat().format(message.offset)} · {formatTime(message.timestamp)} ·{" "}
          {formatBytes(message.valueSize)}
          {/* Only real decodes get a badge — the plain-text fallback used to
              render a "text" badge that read like a view mode and confused
              the 文本 tab. */}
          {decodedOk && decoded!.format !== "text" && decoded!.format !== "json" && (
            <span className="ml-2 rounded bg-ok/15 px-1.5 py-0.5 text-ok">
              {t("msg.viewDecoded")} · {decoded!.format}
            </span>
          )}
        </span>
        <div className="flex-1" />
        <button
          className="btn !px-2"
          title={t("ctx.copyValue")}
          onClick={() => copy(body)}
        >
          <Copy size={12} />
        </button>
        {tabs.map(({ v, label }) => (
          <button
            key={v}
            className={`btn !px-2 ${mode === v ? "btn-accent" : ""}`}
            onClick={() => setMode(v)}
          >
            {label}
          </button>
        ))}
        {onClose && (
          <button
            className="btn !px-1.5"
            title={t("msg.closeDetail")}
            onClick={onClose}
          >
            <X size={13} />
          </button>
        )}
      </div>
      {message.headers && message.headers.length > 0 && (
        <div className="flex flex-wrap gap-2 border-b border-ink-800 px-3 py-1.5 text-11 text-ink-300">
          {message.headers.map((h) => (
            <span
              key={h.key}
              className="rounded bg-ink-800 px-1.5 py-0.5 font-mono selectable"
              onContextMenu={(e) =>
                openCtx(e, [
                  { label: t("ctx.copyHeaderKey"), onSelect: () => copy(h.key) },
                  { label: t("ctx.copyHeaderValue"), onSelect: () => copy(toText(h.value)) },
                ])
              }
            >
              {h.key}={toText(h.value)}
            </span>
          ))}
        </div>
      )}
      {decoded && decoded.error && (
        <div className="mx-3 mt-1.5 rounded border border-warn/40 bg-warn/10 px-2 py-1 text-10 text-ink-200">
          {decoded.error}
        </div>
      )}
      {mode === "decoded" && confluentHint ? (
        // Offline decode: the wire format needs a schema; a local one works
        // without any registry connection. The bar IS the decoded tab here —
        // no raw pre underneath (the hint would render twice).
        <LocalDecodeBar payloadBase64={message.value ?? ""} />
      ) : mode === "json" && isJsonContainer(body) ? (
        // Valid JSON object/array renders as a collapsible tree; scalars and
        // non-JSON payloads keep the plain pre.
        <div
          className="m-3 flex-1 overflow-auto rounded border border-ink-700 bg-ink-900 p-3 font-mono text-11 leading-relaxed text-ink-100 selectable"
          onContextMenu={payloadMenu}
        >
          <JsonView text={body} />
        </div>
      ) : (
        <pre
          className="m-3 flex-1 overflow-auto rounded border border-ink-700 bg-ink-900 p-3 font-mono text-11 leading-relaxed text-ink-100 selectable"
          onContextMenu={payloadMenu}
        >
          {body || "∅"}
        </pre>
      )}
      {ctxMenu}
    </div>
  );
}

function isJsonContainer(text: string): boolean {
  try {
    const v = JSON.parse(text);
    return typeof v === "object" && v !== null;
  } catch {
    return false;
  }
}

// LocalDecodeBar: pick a saved local schema (offline, no registry) and
// decode this Confluent-framed payload with it. Result text replaces the
// hint in place; the decoded value is a pure frontend state per message.
function LocalDecodeBar({ payloadBase64 }: { payloadBase64: string }) {
  const [open, setOpen] = useState(false);
  const [schemas, setSchemas] = useState<LocalSchema[] | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const { open: openCtx, menu: ctxMenu } = useContextMenu();
  const copy = useCopy();
  const toast = { show: useToast((s) => s.show) };

  const openPicker = async () => {
    setOpen(true);
    setResult(null);
    try {
      // The offline decoder handles Avro / Protobuf (dual-format) / JSON —
      // offer every saved schema, labelled with its type.
      const list = (await registryApi.listLocal()) ?? [];
      setSchemas(list);
    } catch (err) {
      setSchemas([]);
      toast.show(friendlyError(err), "error");
    }
  };

  const decodeWith = async (s: LocalSchema) => {
    try {
      const r = await registryApi.decodeLocal(s.schemaType, s.schema, payloadBase64);
      if (r.error) {
        setResult({ ok: false, text: `${s.name}: ${r.error}` });
      } else {
        setResult({ ok: true, text: `${s.name} →\n${r.text}` });
      }
    } catch (err) {
      setResult({ ok: false, text: friendlyError(err) });
    }
  };

  return (
    <div className="mx-3 mt-1.5 rounded border border-accent/40 bg-accent/10 px-2.5 py-2 text-11">
      <div className="flex items-center gap-2">
        <span className="flex-1 text-ink-200">{t("decode.confluentHint", detectFormat(base64Of(payloadBase64))?.schemaId ?? 0)}</span>
        <button className="btn !py-0.5" onClick={() => void openPicker()}>
          {t("decode.withLocal")}
        </button>
      </div>
      {result && (
        <pre
          className={`mt-1.5 max-h-40 overflow-auto rounded px-2 py-1.5 font-mono text-10 selectable ${
            result.ok ? "bg-ink-900 text-ink-100" : "bg-danger/10 text-danger"
          }`}
          onContextMenu={(e) =>
            openCtx(e, [{ label: t("ctx.copyValue"), onSelect: () => copy(result.text) }])
          }
        >
          {result.text}
        </pre>
      )}
      {ctxMenu}
      {open && (
        <Modal title={t("decode.pickLocal")} width={420} onClose={() => setOpen(false)}>
          {(close) => (
            <div className="max-h-80 space-y-1 overflow-auto">
              {schemas === null && <div className="p-2 text-11 text-ink-400">…</div>}
              {schemas !== null && schemas.length === 0 && (
                <div className="p-2 text-11 text-ink-300">{t("reg.localEmpty")}</div>
              )}
              {(schemas ?? []).map((s) => (
                <button
                  key={s.id}
                  className="btn w-full justify-start"
                  onClick={() => {
                    close();
                    void decodeWith(s);
                  }}
                >
                  <BookMarked size={12} /> <span className="truncate">{s.name}</span>
                  <span className="ml-auto text-10 text-ink-400">{s.schemaType}</span>
                </button>
              ))}
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}

function renderRaw(m: Message, mode: ViewMode): string {
  if (mode === "hex") return toHex(m.value);
  // Smart chain: UTF-8 strict → UTF-16 BOM → GBK → Latin-1 — GBK/UTF-16
  // payloads render as real text instead of replacement glyphs. The bytes
  // stay untouched; JSON pretty-printing applies to the decoded text.
  const bytes = base64Of(m.value);
  const { text } = smartText(bytes);
  if (mode === "json") return prettyJson(text);
  return text;
}

function base64Of(b64?: string): Uint8Array {
  if (!b64) return new Uint8Array();
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return new Uint8Array();
  }
}
