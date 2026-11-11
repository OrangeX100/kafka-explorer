// Human-readable hints for raw config values. Kafka stores durations in
// milliseconds and sizes in bytes as bare integers — 9223372036854775807
// means nothing to a person, so we translate. Unit words follow the active
// locale (zh-CN → 天, en → days).
//
// PRECISION: 9223372036854775807 (Long.MAX) exceeds Number.MAX_SAFE_INTEGER
// (2^53-1); as a number literal it silently becomes ...776000. Long.MAX is
// ALWAYS kept as a string here, and anything above MAX_SAFE_INTEGER is
// treated as "unlimited" — past ~285,000 years the difference is moot and
// every remaining integer is exactly representable.
import { resolvedLocale } from "./i18n.js";

// Long.MAX_VALUE, exact, as a string. Never write it as a number literal.
export const MS_MAX_STRING = "9223372036854775807";

type Words = {
  day: string;
  hour: string;
  minute: string;
  second: string;
  ms: string;
  unlimited: string;
  never: string;
  immediate: string;
  followMs: string;
  followBytes: string;
  followParent: string;
  negative: string;
  noLimit1: string;
  messages: string;
};

const WORDS: Record<"zh-CN" | "en", Words> = {
  "zh-CN": {
    day: "天",
    hour: "小时",
    minute: "分钟",
    second: "秒",
    ms: "毫秒",
    unlimited: "无上限（永不）",
    never: "永不",
    immediate: "0（立即生效）",
    followMs: "跟随 retention.ms（实际保留时长）",
    followBytes: "跟随 retention.bytes（实际保留上限）",
    followParent: "跟随上级配置",
    negative: "负数：保留策略特殊值（见说明）",
    noLimit1: "不限制",
    messages: "条",
  },
  en: {
    day: "days",
    hour: "hours",
    minute: "min",
    second: "sec",
    ms: "ms",
    unlimited: "Unlimited (never)",
    never: "never",
    immediate: "0 (immediate)",
    followMs: "Follows retention.ms (actual retention)",
    followBytes: "Follows retention.bytes (actual cap)",
    followParent: "Follows the parent config",
    negative: "Negative: retention policy sentinel (see docs)",
    noLimit1: "No limit",
    messages: "records",
  },
};

function words(): Words {
  return WORDS[resolvedLocale()] ?? WORDS["zh-CN"];
}

function humanDuration(ms: number): string {
  const w = words();
  const units: [number, string][] = [
    [86400000, w.day],
    [3600000, w.hour],
    [60000, w.minute],
    [1000, w.second],
  ];
  let rest = ms;
  const parts: string[] = [];
  for (const [unit, name] of units) {
    const q = Math.floor(rest / unit);
    if (q > 0) {
      parts.push(`${q} ${name}`);
      rest -= q * unit;
    }
    if (parts.length >= 2) break; // two units is plenty for a hint
  }
  if (parts.length === 0) parts.push(`${ms} ${w.ms}`);
  return parts.join(" ");
}

function humanBytes(n: number): string {
  if (n >= 2 ** 30) return `${round(n / 2 ** 30)} GB`;
  if (n >= 2 ** 20) return `${round(n / 2 ** 20)} MB`;
  if (n >= 2 ** 10) return `${round(n / 2 ** 10)} KB`;
  return `${n} B`;
}

function round(n: number): string {
  return Number(n.toFixed(1)).toString();
}

// configHint returns a short human explanation for numeric values, or null
// when the value needs no translation (non-numeric / plain strings).
export function configHint(name: string, value: string): string | null {
  const trimmed = value.trim();
  // Integers AND decimals — ratios (0.5) are fractions, everything else is
  // a bare integer. Anything non-numeric (strings, lists) stays untranslated.
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return null;
  // Every numeric-unit family found across broker+topic config keys.
  // Durations come in four spellings (ms/seconds/secs/minutes/hours), sizes
  // in bytes, throughput in bytes-per-second, ratios are 0..1 fractions and
  // messages is a plain count with the Long.MAX "unlimited" sentinel.
  const isMs = name.endsWith(".ms");
  const isSeconds = name.endsWith(".seconds") || name.endsWith(".secs");
  const isMinutes = name.endsWith(".minutes");
  const isHours = name.endsWith(".hours");
  const isBytes = name.endsWith(".bytes");
  const isRate = name.endsWith(".bytes.per.second");
  const isRatio = name.endsWith(".ratio");
  const isMessages = name.endsWith(".messages");
  const isDuration = isMs || isSeconds || isMinutes || isHours;
  if (!isDuration && !isBytes && !isRate && !isRatio && !isMessages) return null;
  const w = words();

  // Sign and small values are exact via Number; anything beyond
  // MAX_SAFE_INTEGER can only mean "unlimited" here, compared as string.
  const n = Number(trimmed);
  if (n < 0) {
    if (n === -1) return w.noLimit1;
    if (n === -2) {
      // Broker form carries the log. prefix (log.local.retention.bytes);
      // topic form does not (local.retention.ms).
      if (name === "local.retention.ms" || name.endsWith("log.local.retention.ms")) return w.followMs;
      if (name === "local.retention.bytes" || name.endsWith("log.local.retention.bytes")) return w.followBytes;
      return w.followParent;
    }
    return w.negative;
  }
  if (n === 0) return isDuration || isRate ? w.immediate : "0";
  // Values beyond MAX_SAFE_INTEGER cannot be represented exactly — and they
  // are all at least ~285,000 years, so "unlimited" is the honest hint.
  if (trimmed === MS_MAX_STRING || n > Number.MAX_SAFE_INTEGER) return w.unlimited;
  if (isMs) return `≈ ${humanDuration(n)}`;
  if (isSeconds) return `≈ ${humanDuration(n * 1000)}`;
  if (isMinutes) return `≈ ${humanDuration(n * 60000)}`;
  if (isHours) return `≈ ${humanDuration(n * 3600000)}`;
  if (isRate) return `≈ ${humanBytes(n)}/s`;
  if (isRatio) return `≈ ${Math.round(n * 100)}%`;
  if (isMessages) return `${n.toLocaleString()} ${w.messages ?? ""}`.trim();
  return `≈ ${humanBytes(n)}`;
}

// Preset chips for the edit dialog: sensible values a person understands,
// converted back to the raw unit on click.
export function configPresets(name: string): { label: string; value: string }[] {
  const w = words();
  const isMs = name.endsWith(".ms");
  const isBytes = name.endsWith(".bytes");
  const isLocal = name.startsWith("local.retention");
  if (isMs) {
    const presets = [
      { label: w.noLimit1 + " (-1)", value: "-1" },
      { label: `1 ${w.minute}`, value: "60000" },
      { label: `1 ${w.hour}`, value: "3600000" },
      { label: `1 ${w.day}`, value: "86400000" },
      { label: `7 ${w.day}`, value: "604800000" },
      { label: `30 ${w.day}`, value: "2592000000" },
      { label: w.unlimited, value: MS_MAX_STRING },
    ];
    if (isLocal) presets.unshift({ label: "retention.ms (-2)", value: "-2" });
    return presets;
  }
  if (isBytes) {
    const presets = [
      { label: w.noLimit1 + " (-1)", value: "-1" },
      { label: "100 MB", value: String(100 * 2 ** 20) },
      { label: "1 GB", value: String(2 ** 30) },
      { label: "10 GB", value: String(10 * 2 ** 30) },
      { label: "100 GB", value: String(100 * 2 ** 30) },
    ];
    if (isLocal) presets.unshift({ label: "retention.bytes (-2)", value: "-2" });
    return presets;
  }
  return [];
}
