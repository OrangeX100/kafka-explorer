// bestViewFor: per-record detail-view selection. See MessagesView's
// effect for why it exists — the detail pane must never open on a view
// that renders replacement glyphs for the selected record.
import { bytesOf, detectFormat, displayFor, isTransactionMarker, smartText } from "../../shared/binary.js";
import { internalRecordOverride, internalRowDisplay } from "../../shared/kafkaInternal.js";
import type { Message } from "../../shared/contracts.js";

// rowCells resolves the Key/Value TABLE cells for a record: internal-topic
// structs decode first (kafkaInternal), then transaction markers, then the
// binary sniffer — every payload lands on readable text or a labeled
// format, never a replacement-glyph wall.
export function rowCells(
  topic: string,
  m: Message,
  t: (key: string, ...args: (string | number)[]) => string,
): { keyCell: string; valueCell: string } {
  const { key: displayKey, value: displayValue } = internalRowDisplay(topic, m.key ?? "", m.value ?? "", t);
  const keyCell = displayKey ?? displayFor(m.key ?? "", t)?.text ?? "";
  const valueCell =
    displayValue ??
    (isTransactionMarker(m.key ?? "", m.value ?? "")
      ? t("fmt.transaction", m.valueSize)
      : displayFor(m.value ?? "", t)?.text ?? "");
  return { keyCell, valueCell };
}

export // bestViewFor decides the detail-pane view for a record (see the effect
// comment). Ordered so that whichever tab it returns is guaranteed to
// actually exist in MessageDetail's tab bar.
function bestViewFor(
  topic: string,
  m: Message,
  t: (key: string, ...args: (string | number)[]) => string,
): "decoded" | "json" | "hex" | "text" {
  // 1) real decode: internal-topic override (front-end, always available
  //    for internal topics) or a Schema-Registry decode (needs 解码 on + SR).
  const override = internalRecordOverride(topic, m.key ?? "", m.value ?? "", t);
  if (override) return "decoded";
  const decoded = m.decoded;
  // format:"json"/"text" are backend FALLBACKS (the JSON/文本 tabs already
  // render those) — only a real decode selects the 已解码 tab.
  if (decoded && !decoded.error && decoded.text && decoded.format !== "text" && decoded.format !== "json") return "decoded";
  // 2) payload sniffing
  const bytes = bytesOf(m.value ?? "");
  const fmt = detectFormat(bytes);
  if (fmt?.kind === "confluent") return "decoded"; // guided hint tab
  if (fmt) return "hex"; // opaque container: raw bytes beat glyph soup
  if (isTransactionMarker(m.key ?? "", m.value ?? "")) return "hex";
  // 3) text family — JSON gets the tree, everything readable stays plain
  const { text, encoding } = smartText(bytes);
  const garbled = (text.match(/�/g) ?? []).length > text.length * 0.1;
  if (garbled || encoding === "latin1") return "hex";
  try {
    JSON.parse(text);
    return "json";
  } catch {
    return "text";
  }
}

// migrateSelected: reload survival for the open detail — after a page
// reload (decode toggle, refresh) the same record (partition+offset) in the
// fresh rows replaces the stale copy so the detail upgrades in place;
// otherwise the selection clears. Clicking right after ticking 解码 used to
// render the stale hint and need a second click.
export function migrateSelected(
  msgs: Message[],
  cur: Message | null,
): Message | null {
  if (!cur) return null;
  return msgs.find((m) => m.partition === cur.partition && m.offset === cur.offset) ?? null;
}
