// Minimal i18n: explicit JSON imports (bundled at build time), zustand store
// for reactivity, t() with {0} placeholders. Key parity across locales is
// enforced by scripts/audit-i18n.mjs, not by hope.
import { create } from "zustand";
import zhCN from "./locales/zh-CN.json";
import en from "./locales/en.json";

export type Locale = "zh-CN" | "en";
// "system" follows the OS UI language (zh* -> zh-CN, else English).
export type LocalePref = Locale | "system";

const bundles: Record<Locale, Record<string, string>> = {
  "zh-CN": zhCN,
  en: en,
};

interface I18nState {
  locale: LocalePref;
  setLocale: (l: LocalePref) => void;
}

// Locale is a UI preference owned by localStorage (same ownership model as
// ke.theme): the user can switch it without saving, so no server row may
// silently revert it at boot.
const LOCALE_KEY = "ke.locale";

function storedLocale(): LocalePref {
  const v = localStorage.getItem(LOCALE_KEY);
  return v === "en" || v === "system" ? v : "zh-CN";
}

function systemLocale(): Locale {
  return (navigator.language ?? "").toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

export function resolvedLocale(): Locale {
  const pref = useI18n.getState().locale;
  return pref === "system" ? systemLocale() : pref;
}

export const useI18n = create<I18nState>((set) => ({
  locale: storedLocale(),
  setLocale: (locale) => {
    localStorage.setItem(LOCALE_KEY, locale);
    set({ locale });
  },
}));

// t returns the key itself when missing — a missing key must be loud, not
// silently blank (audit-i18n catches it at build time; this catches runtime).
export function t(key: string, ...args: (string | number)[]): string {
  const bundle = bundles[resolvedLocale()];
  const template = bundle[key] ?? key;
  return template.replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)] ?? ""));
}

export const localeNames: Record<Locale, string> = { "zh-CN": "简体中文", en: "English" };
