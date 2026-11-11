// Font presets for the settings page (split Latin / CJK typography).
// Extracted from settings.ts to keep both files inside the structure
// budget — the backend whitelist (settings_service.go fontFamilies) must
// stay in sync with the keys here.

// A preset carries its installed family NAME (used for both the CSS stack
// and document.fonts.check detection) and the full fallback chain.
export interface FontPreset {
  key: string;
  family: string; // primary installed name for CSS + detection
  stack: string; // full fallback chain
  license: string; // short badge, shown in the picker label
  shipped: boolean; // true = ships with Windows, always available (skip detection)
  label?: string; // display name override (e.g. "跟随中文字体" for the "" default)
}

// Latin presets apply to letters/digits/punctuation; CJK characters fall
// through to the CJK stack below (CSS font fallback is per-glyph).
export const LATIN_FONTS: FontPreset[] = [
  { key: "", family: "", label: "跟随中文字体", stack: "", license: "默认", shipped: true },
  { key: "segoe", family: "Segoe UI", stack: '"Segoe UI", system-ui, sans-serif', license: "系统", shipped: true },
  { key: "inter", family: "Inter", stack: 'Inter, "Segoe UI", system-ui, sans-serif', license: "OFL", shipped: false },
  { key: "roboto", family: "Roboto", stack: "Roboto, system-ui, sans-serif", license: "Apache-2.0", shipped: false },
  { key: "openSans", family: "Open Sans", stack: '"Open Sans", system-ui, sans-serif', license: "OFL", shipped: false },
  { key: "sourceSans3", family: "Source Sans 3", stack: '"Source Sans 3", system-ui, sans-serif', license: "OFL", shipped: false },
  { key: "jetBrainsMono", family: "JetBrains Mono", stack: '"JetBrains Mono", Consolas, monospace', license: "OFL 等宽", shipped: false },
  { key: "firaCode", family: "Fira Code", stack: '"Fira Code", Consolas, monospace', license: "OFL 等宽", shipped: false },
  { key: "cascadiaCode", family: "Cascadia Code", stack: '"Cascadia Code", Consolas, monospace', license: "OFL 等宽", shipped: false },
];

// CJK presets form the BASE stack; the chosen Latin family is prepended.
export const CJK_FONTS: FontPreset[] = [
  { key: "", family: "system-ui", label: "系统默认", stack: 'system-ui, "Segoe UI", "Microsoft YaHei", sans-serif', license: "默认", shipped: true },
  { key: "yaHei", family: "Microsoft YaHei", stack: '"Microsoft YaHei", "PingFang SC", sans-serif', license: "系统", shipped: true },
  { key: "dengXian", family: "DengXian", stack: 'DengXian, "Microsoft YaHei", sans-serif', license: "系统", shipped: true },
  { key: "simSun", family: "SimSun", stack: "SimSun, serif", license: "系统", shipped: true },
  { key: "sourceHanSans", family: "Source Han Sans SC", stack: '"Source Han Sans SC", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif', license: "OFL", shipped: false },
  { key: "sourceHanSerif", family: "Source Han Serif SC", stack: '"Source Han Serif SC", "Noto Serif CJK SC", SimSun, serif', license: "OFL", shipped: false },
  { key: "lxgwWenKai", family: "LXGW WenKai", stack: '"LXGW WenKai", "LXGW WenKai GB", "Microsoft YaHei", sans-serif', license: "OFL", shipped: false },
  { key: "miSans", family: "MiSans", stack: 'MiSans, "Microsoft YaHei", sans-serif', license: "免费商用", shipped: false },
  { key: "harmonySans", family: "HarmonyOS Sans SC", stack: '"HarmonyOS Sans SC", "Microsoft YaHei", sans-serif', license: "免费商用", shipped: false },
  { key: "puHuiTi", family: "Alibaba PuHuiTi 3.0", stack: '"Alibaba PuHuiTi 3.0", "Alibaba PuHuiTi", "Microsoft YaHei", sans-serif', license: "免费商用", shipped: false },
];

function cjkStack(key: string): string {
  return CJK_FONTS.find((f) => f.key === key)?.stack ?? CJK_FONTS[0].stack;
}

// applyFontStack combines the two picks: Latin family FIRST (Latin letters
// and digits render with it), then the CJK stack as the per-glyph fallback
// for Chinese characters. Empty Latin = the CJK stack untouched.
export function applyFontStack(fontLatin: string, fontFamily: string): string {
  const latin = LATIN_FONTS.find((f) => f.key === fontLatin)?.family;
  const base = cjkStack(fontFamily);
  return latin ? `"${latin}", ${base}` : base;
}

// document.fonts.check reports whether a locally-installed family renders.
// Shipped-with-Windows presets skip the check (always available).
export async function detectFontAvailability(): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  try {
    await document.fonts.ready;
    for (const f of [...LATIN_FONTS, ...CJK_FONTS]) {
      out[f.key] = f.shipped || document.fonts.check(`12px "${f.family}"`) || document.fonts.check(`12px "${f.family} Light"`);
    }
  } catch {
    // detection is a nicety — on failure every picker item renders neutral
  }
  return out;
}
