// Byte/bytes formatting helpers shared by the message views.

// decodeBase64 tolerates ANY input: the backend always emits valid
// StdEncoding, but a dirty payload (old row, future contract change) must
// not throw inside an event handler and kill a copy action — the callers
// that care about strictness validate before calling (045 round).
export function decodeBase64(b64: string): Uint8Array {
  let bin = "";
  try {
    bin = atob(b64);
  } catch {
    // Not valid base64: degrade to the raw bytes of the input text so the
    // caller still renders something sane instead of throwing.
    return new TextEncoder().encode(b64);
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function encodeBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function toText(b64?: string): string {
  if (!b64) return "";
  const bytes = decodeBase64(b64);
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

// PrettyJson tries JSON.parse on the decoded text and re-stringifies with
// indentation; non-JSON payloads come back unchanged.
export function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

// Hex view cap: 10MB of payload once produced a 650k-line <pre> that hung
// layout for 10s+ (045 round-5). Beyond the cap show the first slice with
// an explicit truncation marker — the raw bytes are still copyable via the
// base64 actions.
const HEX_MAX_BYTES = 1 << 20;

export function toHex(b64?: string): string {
  if (!b64) return "";
  const bytes = decodeBase64(b64);
  const capped = bytes.length > HEX_MAX_BYTES;
  const view = capped ? bytes.slice(0, HEX_MAX_BYTES) : bytes;
  const lines: string[] = [];
  for (let i = 0; i < view.length; i += 16) {
    const slice = view.slice(i, i + 16);
    const hex = Array.from(slice, (b) => b.toString(16).padStart(2, "0")).join(" ");
    const ascii = Array.from(slice, (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".")).join("");
    lines.push(`${i.toString(16).padStart(8, "0")}  ${hex.padEnd(47)}  ${ascii}`);
  }
  if (capped) {
    lines.push(`…已截断：共 ${bytes.length} 字节，仅显示前 ${HEX_MAX_BYTES} 字节的十六进制视图`);
  }
  return lines.join("\n");
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat().format(n);
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { hour12: false });
}
