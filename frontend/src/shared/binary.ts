// Binary format sniffing and display fallbacks for Kafka record keys/values.
//
// Goal: NO cell in the messages table should ever render a wall of U+FFFD
// replacement glyphs. Every payload resolves to one of:
//   1. readable text (UTF-8, or GBK / UTF-16 via the fallback chain)
//   2. a labeled format ("gzip 压缩 · 1.2 KB", "Confluent 序列化 · schema 42")
//   3. an unlabeled-size binary note ("二进制数据 · N B")
// The raw bytes stay available in the Hex tab; labels never destroy data.
//
// Pure functions only: runs in the app AND under node
// --experimental-strip-types for unit tests.

export type FormatKind =
  | "utf8"
  | "utf16"
  | "gbk"
  | "latin1"
  | "gzip"
  | "zstd"
  | "lz4"
  | "snappy"
  | "zip"
  | "png"
  | "jpeg"
  | "gif"
  | "java"
  | "bson"
  | "msgpack"
  | "confluent"
  | "transaction"
  | "binary";

export interface FormatInfo {
  kind: FormatKind;
  // Confluent wire format carries the schema registry id at bytes 1..5.
  schemaId?: number;
}

function startsWith(b: Uint8Array, magic: number[]): boolean {
  if (b.length < magic.length) return false;
  return magic.every((byte, i) => b[i] === byte);
}

function bsonConsistent(b: Uint8Array): boolean {
  // BSON: int32 LE total length at 0, terminating 0x00 at the end.
  if (b.length < 5) return false;
  const len = b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24);
  return len === b.length && b[b.length - 1] === 0;
}

function msgpackPlausible(b: Uint8Array): boolean {
  // Conservative sniff of the first byte's major type — CONTAINER types
  // only. fixstr (0xa0-0xbf) is deliberately excluded: GBK/Latin-1 lead
  // bytes live in the same range and would mislabel plain Chinese text.
  const c = b[0];
  const fixmap = (c & 0xf0) === 0x80;
  const fixarray = (c & 0xf0) === 0x90;
  return fixmap || fixarray || c === 0xde || c === 0xcf || c === 0xdc || c === 0xdd;
}

// detectFormat identifies known binary containers by magic bytes. Unknown
// content falls through to text decoding (smartText decides).
export function detectFormat(b: Uint8Array): FormatInfo | null {
  if (b.length === 0) return null;
  if (startsWith(b, [0x1f, 0x8b])) return { kind: "gzip" };
  if (startsWith(b, [0x28, 0xb5, 0x2f, 0xfd])) return { kind: "zstd" };
  if (startsWith(b, [0x04, 0x22, 0x4d, 0x18])) return { kind: "lz4" };
  if (startsWith(b, [0xff, 0x06, 0x00, 0x00, 0x53, 0x4e, 0x41, 0x50, 0x50, 0x59])) return { kind: "snappy" };
  if (startsWith(b, [0x50, 0x4b, 0x03, 0x04]) || startsWith(b, [0x50, 0x4b, 0x05, 0x06])) return { kind: "zip" };
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47])) return { kind: "png" };
  if (startsWith(b, [0xff, 0xd8, 0xff])) return { kind: "jpeg" };
  if (startsWith(b, [0x47, 0x49, 0x46, 0x38])) return { kind: "gif" };
  if (startsWith(b, [0xac, 0xed, 0x00, 0x05])) return { kind: "java" };
  if (bsonConsistent(b)) return { kind: "bson" };
  if (msgpackPlausible(b)) return { kind: "msgpack" };
  // Confluent wire format: 0x00 magic + big-endian 4-byte schema id.
  // (Avro / Protobuf / JSON-Schema all share this envelope; the Schema
  // Registry knows the subject's real type, we only label the envelope.)
  if (b[0] === 0x00 && b.length >= 5) {
    const schemaId = (b[1] << 24) | (b[2] << 16) | (b[3] << 8) | b[4];
    if (schemaId > 0 && schemaId < 0x10000) return { kind: "confluent", schemaId };
  }
  return null;
}

// isTransactionMarker: Kafka control records carry a NULL key and a tiny
// value (version:2 + type:2, optionally + coordinator epoch:4). Plain text
// like "hello" is also 5 bytes, so the null key is what makes it a marker.
export function isTransactionMarker(keyB64: string, valueB64: string): boolean {
  if (keyB64) return false;
  try {
    const bin = atob(valueB64);
    if (bin.length !== 4 && bin.length !== 8) return false;
    const version = bin.charCodeAt(0) << 8 | bin.charCodeAt(1);
    return version === 0 || version === 1;
  } catch {
    return false;
  }
}

function decodeStrict(b: Uint8Array, label: string): string | null {
  try {
    return new TextDecoder(label, { fatal: true }).decode(b);
  } catch {
    return null;
  }
}

function printableRatio(s: string): number {
  if (s.length === 0) return 1;
  let ok = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x09 || c === 0x0a || c === 0x0d || (c >= 0x20 && c !== 0x7f) || c === 0xfffd) ok++;
  }
  return ok / s.length;
}

// smartText runs the text-encoding fallback chain. Chromium (WebView2)
// ships the full WHATWG encodings, so GBK/GB18030 decoding works in-app.
// latin1 is the terminal fallback: it NEVER produces replacement glyphs,
// which is what keeps cells readable even for undecodable bytes.
export function smartText(b: Uint8Array): { text: string; encoding: FormatKind } {
  if (b.length === 0) return { text: "", encoding: "utf8" };
  const utf8 = decodeStrict(b, "utf-8");
  if (utf8 !== null) return { text: utf8, encoding: "utf8" };
  if (startsWith(b, [0xff, 0xfe]) || startsWith(b, [0xfe, 0xff])) {
    try {
      return { text: new TextDecoder("utf-16").decode(b), encoding: "utf16" };
    } catch {
      /* fall through */
    }
  }
  try {
    const gbk = new TextDecoder("gbk").decode(b);
    if (printableRatio(gbk) >= 0.9) return { text: gbk, encoding: "gbk" };
  } catch {
    /* decoder unavailable — keep falling */
  }
  try {
    return { text: new TextDecoder("windows-1252").decode(b), encoding: "latin1" };
  } catch {
    return { text: new TextDecoder().decode(b), encoding: "latin1" };
  }
}

// formatBytes-lite: this module stays dependency-free for node tests.
function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// bytesOf: base64 → bytes for callers that need the raw payload (best-view
// selection, custom sniffing). Inverse-safe: bad input yields empty bytes.
export function bytesOf(b64: string): Uint8Array {
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

export interface DisplayResult {
  text: string;
  // what the cell represents: "text" (readable, encoding applied),
  // "format" (labeled binary container), "binary" (opaque note)
  style: "text" | "format" | "binary";
}

// displayFor resolves a payload to its table-cell representation. t maps
// format keys to localized labels; humanSize stays internal.
export function displayFor(
  b64: string,
  t: (key: string, ...args: (string | number)[]) => string,
): DisplayResult | null {
  if (!b64) return null;
  let b: Uint8Array;
  try {
    const bin = atob(b64);
    b = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  } catch {
    return { text: "", style: "binary" };
  }
  const fmt = detectFormat(b);
  if (fmt) {
    const size = humanSize(b.length);
    if (fmt.kind === "confluent") return { text: t("fmt.confluent", fmt.schemaId ?? 0, size), style: "format" };
    return { text: t(`fmt.${fmt.kind}`, size), style: "format" };
  }
  const { text, encoding } = smartText(b);
  const garbled = (text.match(/\ufffd/g) ?? []).length > text.length * 0.1;
  if (garbled) return { text: t("fmt.binary", humanSize(b.length)), style: "binary" };
  // Readable text — UTF-8/GBK/UTF-16 already applied; latin1-marked text
  // that still looks binary gets the binary note instead.
  if (encoding === "latin1") {
    const ctrl = [...text].filter((c) => {
      const c0 = c.charCodeAt(0);
      return c0 < 0x20 && c0 !== 0x09 && c0 !== 0x0a && c0 !== 0x0d;
    }).length;
    if (ctrl > text.length * 0.1) return { text: t("fmt.binary", humanSize(b.length)), style: "binary" };
  }
  return { text, style: "text" };
}
