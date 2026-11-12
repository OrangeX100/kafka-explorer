// App-wide settings state: loaded once at boot from the backend, updated
// by the settings page. Views read from here (e.g. showInternal filtering).
// Font presets live in fonts.ts (split Latin / CJK typography).
import { create } from "zustand";
import { settingsApi } from "../shared/api.js";
import type { AppSettings } from "../shared/contracts-admin.js";
import { applyFontStack } from "./fonts.js";

interface SettingsState {
  settings: AppSettings | null;
  load: () => Promise<void>;
  update: (s: AppSettings) => void;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "light",
  locale: "zh-CN",
  density: "compact",
  fontSize: 14, // UI zoom baseline (zoom = fontSize / 14)
  fontFamily: "", // "" = system stack (styles.css default); CJK/base font
  fontLatin: "", // "" = no Latin preference (Latin chars follow the CJK stack)
  pageSize: 50, // 50 per page by default ; user-adjustable in Settings
  showInternal: false, // internal topics hidden by default: cleaner list
  maxScan: 100000,
  updateRepo: "", // empty = the release-baked source (buildinfo.UpdateRepo)
  autoCheckUpdate: true,
  closeToTray: true,
};

// Typography applies at two layers:
//  - fontSize  → ROOT font-size (rem scale): Tailwind sizes are rem-based,
//    so text AND spacing scale together. This REPLACED body CSS zoom,
//    which broke position:sticky (config table headers detached under
//    zoom) and forced mouse-coordinate conversions everywhere.
//  - font stack → CSS custom property consumed by #root in styles.css
//    (elements with explicit leading-* keep overriding locally). The old
//    lineHeight preference was removed as noise — global leading is fixed
//    at 1.5 in styles.css.
export function applyTypography(s: Pick<AppSettings, "fontSize" | "fontFamily" | "fontLatin">) {
  const html = document.documentElement.style;
  html.fontSize = `${(s.fontSize * 16) / 14}px`;
  html.setProperty("--app-font", applyFontStack(s.fontLatin, s.fontFamily));
}

export const useAppSettings = create<SettingsState>((set) => ({
  settings: null,
  load: async () => {
    try {
      // NOTE: deliberately NO pageSize normalization here. An earlier
      // migration forced 100/100_000 back to the new 50 default, which
      // meant a user who deliberately picked 100/页 got it silently
      // reverted on every load. Any value within the backend's validated
      // range (10..1_000_000) is a legitimate user choice now.
      const row = await settingsApi.get();
      const s = { ...row };
      // Legacy single-font keys migrate to the split latin/CJK settings:
      // mono was a Latin monospace preference, serif ≈ 宋体 flavor.
      if (s.fontFamily === "mono") {
        s.fontLatin = "jetBrainsMono";
        s.fontFamily = "";
      } else if (s.fontFamily === "serif") {
        s.fontFamily = "simSun";
      }
      if (s.fontLatin === undefined) s.fontLatin = "";
      applyTypography(s);
      set({ settings: s });
    } catch {
      applyTypography(DEFAULT_SETTINGS);
      set({ settings: DEFAULT_SETTINGS });
    }
  },
  update: (settings) => {
    applyTypography(settings);
    set({ settings });
  },
}));
