// Locale-aware display helpers for config keys. The dictionaries
// (brokerConfigDocs*, topicConfigDocs) are Chinese-first; English mode shows
// the readable key plus the broker's own documentation string, which is the
// authoritative English text. Unknown keys fall back the same way, so a
// config row is never left half-translated.
import { resolvedLocale } from "./i18n.js";
import { configMeta as brokerMeta } from "./brokerConfigDocsMeta.js";
import { configMeta as topicMeta } from "./topicConfigDocs.js";

// Readable English label from the raw key: "log.retention.hours" →
// "Log Retention Hours".
export function readableName(key: string): string {
  return key
    .split(".")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

// Display name for a config key: Chinese dictionary in zh-CN; readable key
// in English.
export function configName(key: string): string {
  if (resolvedLocale() === "zh-CN") {
    const m = brokerMeta(key) ?? topicMeta(key);
    return m ? m.zh : key;
  }
  return readableName(key);
}

// stripHtml: broker doc strings are HTML fragments (<p>, <em>, <ol>,
// &quot; …). Render them as-is would leak markup into the UI and rendering
// raw HTML from a wire payload is a footgun — convert to plain text instead:
// list items become bullets, block tags become newlines, entities decode.
export function stripHtml(html: string): string {
  if (!html) return "";
  return html
    .replace(/<li[^>]*>/gi, "\n• ")
    .replace(/<\/(p|ol|ul|li|h[1-6]|div|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Description for the EDIT DIALOG (tables no longer carry a description
// column). Returns { summary, official }: summary is the locale-matched
// dictionary text (Chinese) — undefined in English mode; official is the
// broker's documentation, HTML-stripped, and is the same authoritative text
// in both languages. That is why the two locales differ: the Chinese side is
// a hand-written digest, the official Kafka docs only exist in English.
export function configDescParts(key: string, brokerDoc?: string): { summary?: string; official?: string } {
  const broker = stripHtml(brokerDoc ?? "") || undefined;
  if (resolvedLocale() === "zh-CN") {
    const m = brokerMeta(key) ?? topicMeta(key);
    if (!m) return { official: broker };
    // zh mode: the dictionary digest + the translated official doc (falling
    // back to the broker's English text when no translation exists).
    const official = stripHtml(m.doc ?? "") || broker;
    const same = official && official === m.desc;
    return { summary: m.desc, official: same ? undefined : official };
  }
  return { official: broker };
}

// Short description: dictionary digest in Chinese, stripped broker doc in
// English. Used for copy actions and tooltips.
export function configDesc(key: string, brokerDoc?: string): string {
  const { summary, official } = configDescParts(key, brokerDoc);
  return summary ?? official ?? "";
}
