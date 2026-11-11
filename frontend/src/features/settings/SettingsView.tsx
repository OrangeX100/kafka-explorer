import { useEffect, useRef, useState } from "react";
import { Database, Download, Info, SlidersHorizontal, Tag, Upload } from "lucide-react";
import { settingsApi, friendlyError, systemApi } from "../../shared/api.js";
import { useToast } from "../../state/stores.js";
import { t, useI18n, type LocalePref } from "../../shared/i18n.js";
import { useTheme, type Theme } from "../../shared/theme.js";
import { useAppSettings, applyTypography } from "../../state/settings.js";
import { LATIN_FONTS, CJK_FONTS, detectFontAvailability, type FontPreset } from "../../state/fonts.js";
import { Switch } from "../common/controls.js";
import type { AppSettings } from "../../shared/contracts-admin.js";
import { Row, SectionTitle } from "./Section.js";
import { AboutSection, UpdateSection } from "./AboutSection.js";
import { Select } from "../common/controls.js";

// SettingsView: user preferences persisted server-side (SQLite settings
// table) with a boot-time localStorage cache on the frontend. Sections:
// appearance (live-previewed), data, version/updates (AboutSection.tsx),
// about (AboutSection.tsx).
export function SettingsView() {
  // Font availability: document.fonts.check per preset, once per mount.
  // Uninstalled picks stay selectable (user may install later) but are
  // labelled so the dropdown never promises a font the machine lacks.
  const [availability, setAvailability] = useState<Record<string, boolean>>({});
  useEffect(() => {
    void detectFontAvailability().then(setAvailability);
  }, []);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [section, setSection] = useState<SectionId>("appearance");
  const toast = useToast();
  const loadedRef = useRef(false);
  // Content fingerprint: the server echo (setSettings(saved)) and the
  // boot-time merge both flow through the same state — comparing the JSON
  // serialisation is what breaks the save → echo → save loop.
  const lastSavedRef = useRef("");

  // AUTO-SAVE (debounced): every settings change persists 600ms after the
  // last edit. MUST stay before the early return below — hooks count may
  // never differ between the loading and loaded renders (React #310).
  useEffect(() => {
    if (!settings) return;
    const json = JSON.stringify(settings);
    if (json === lastSavedRef.current) return;
    lastSavedRef.current = json;
    const timer = setTimeout(() => {
      settingsApi
        .save(settings)
        .then((saved) => {
          setSettings(saved);
          useAppSettings.getState().update(saved);
          useTheme.getState().set(saved.theme as Theme);
          useI18n.getState().setLocale(saved.locale as LocalePref);
          applyTypography(saved);
          lastSavedRef.current = JSON.stringify(saved);
        })
        .catch((err) => toast.show(friendlyError(err), "error"));
    }, 600);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    settingsApi
      .get()
      .then((s) => {
        // Theme/locale are owned by their localStorage-backed stores — the
        // user toggles them live without saving, so seed the form from the
        // stores and never let the server row revert a live choice here.
        const merged: AppSettings = {
          ...s,
          theme: useTheme.getState().theme,
          locale: useI18n.getState().locale,
        };
        setSettings(merged);
        lastSavedRef.current = JSON.stringify(merged);
        useAppSettings.getState().update(merged);
      })
      .catch((err) => toast.show(friendlyError(err), "error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!settings) return <div className="p-4 text-xs text-ink-400">{t("common.loading")}</div>;

  // AUTO-SAVE: every change persists immediately (debounced 600ms). The
  // old explicit 保存 button is gone — a settings page that needs a save
  const set = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) =>
    setSettings((s) => (s ? { ...s, [key]: value } : s));

  // ---- backup / restore (data section) ----
  const exportAll = async () => {
    try {
      const path = await settingsApi.exportBackup();
      if (path) toast.show(t("settings.backupExportOk"), "ok");
    } catch (err) {
      toast.show(friendlyError(err), "error");
    }
  };
  const importAll = async () => {
    try {
      const path = await systemApi.pickOpenFile(t("settings.backupImportPick"), "*.json");
      if (!path) return; // cancelled
      const counts = await settingsApi.importBackup(path);
      const parts = [
        t("settings.backupImportConns").replace("{0}", String(counts.connections)),
        t("settings.backupImportRegs").replace("{0}", String(counts.registries)),
        t("settings.backupImportConnect").replace("{0}", String(counts.connectClusters)),
        t("settings.backupImportKsql").replace("{0}", String(counts.ksqlDbServers)),
        t("settings.backupImportSchemas").replace("{0}", String(counts.localSchemas)),
      ].join("、");
      toast.show(`${t("settings.backupImportOk")} ${parts}`, "ok");
      // the backup may carry preferences: refresh the form + live stores so
      // the page reflects the imported values instead of the stale ones
      const fresh = await settingsApi.get();
      lastSavedRef.current = JSON.stringify(fresh);
      setSettings(fresh);
      useAppSettings.getState().update(fresh);
      useTheme.getState().set(fresh.theme as Theme);
      useI18n.getState().setLocale(fresh.locale as LocalePref);
      applyTypography(fresh);
      if (counts.needPassword && counts.needPassword.length > 0) {
        toast.show(t("settings.backupImportPw"), "error");
      }
    } catch (err) {
      toast.show(friendlyError(err), "error");
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl gap-4 p-4">
      {/* category rail: one entry per section, VS Code settings style */}
      <nav className="flex w-36 flex-none flex-col gap-0.5 self-start rounded border border-ink-700 bg-ink-900 p-1.5">
        {SECTIONS.map((sec) => (
          <button
            key={sec.id}
            onClick={() => setSection(sec.id)}
            className={`flex items-center gap-1.5 rounded px-2 py-1.5 text-left text-xs transition-colors ${
              section === sec.id ? "bg-accent-muted text-accent" : "text-ink-300 hover:bg-ink-800 hover:text-ink-100"
            }`}
          >
            {sec.icon} {t(sec.labelKey)}
          </button>
        ))}
      </nav>
      <div className="min-w-0 flex-1 space-y-4">
      <h2 className="text-sm font-semibold text-ink-100">{t("settings.title")}</h2>

      {/* ---------- appearance ---------- */}
      {section === "appearance" && (
      <section className="panel p-3">
        <SectionTitle icon={<SlidersHorizontal size={13} />} text={t("settings.appearance")} />
        <div className="space-y-2.5">
          <Row label={t("settings.theme")}>
                        <Select
              className="!w-40"
              value={settings.theme}
              options={[
                { value: "dark", label: t("settings.themeDark") },
                { value: "light", label: t("settings.themeLight") },
                { value: "system", label: t("settings.themeSystem") },
              ]}
              onChange={(v) => {
                set("theme", v);
                useTheme.getState().set(v as Theme); // live preview before save
              }}
            />
          </Row>
          <Row label={t("settings.locale")}>
                        <Select
              className="!w-40"
              value={settings.locale}
              options={[
                { value: "zh-CN", label: "简体中文" },
                { value: "en", label: "English" },
                { value: "system", label: t("settings.localeSystem") },
              ]}
              onChange={(v) => {
                set("locale", v);
                useI18n.getState().setLocale(v as LocalePref); // live preview
              }}
            />
          </Row>
          <Row label={t("settings.fontSize")} hint={t("settings.fontSizeHint")}>
                        <Select
              className="!w-40"
              value={String(settings.fontSize)}
              options={[12, 13, 14, 16, 18].map((px) => ({ value: String(px), label: String(px) }))}
              onChange={(v) => {
                const next = { ...settings, fontSize: Number(v) };
                setSettings(next);
                applyTypography(next); // live preview before save
              }}
            />
          </Row>
          <Row label={t("settings.fontLatin")} hint={t("settings.fontLatinHint")}>
            <Select
              className="!w-64"
              value={settings.fontLatin}
              options={installedOnly(LATIN_FONTS, availability, settings.fontLatin).map((f) => ({
                value: f.key,
                label: fontOptionLabel(f, availability[f.key], t),
              }))}
              onChange={(v) => {
                const next = { ...settings, fontLatin: v };
                setSettings(next);
                applyTypography(next); // live preview
              }}
            />
          </Row>
          <Row label={t("settings.fontCjk")} hint={t("settings.fontCjkHint")}>
            <Select
              className="!w-64"
              value={settings.fontFamily}
              options={installedOnly(CJK_FONTS, availability, settings.fontFamily).map((f) => ({
                value: f.key,
                label: fontOptionLabel(f, availability[f.key], t),
              }))}
              onChange={(v) => {
                const next = { ...settings, fontFamily: v };
                setSettings(next);
                applyTypography(next); // live preview
              }}
            />
          </Row>
        </div>

        {/* live preview: representative text/table/mono samples rendered in
            the current typography — applyTypography already updated the
            root CSS vars, so this panel is genuinely what the app looks like */}
        <div className="mt-3 rounded border border-ink-700 bg-ink-900 p-3" data-testid="settings-preview">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-11 font-medium text-ink-300">{t("settings.preview")}</span>
            <span className="text-10 text-ink-500">{t("settings.previewHint")}</span>
          </div>
          <div className="rounded border border-ink-700 bg-ink-950 p-3">
            <div className="text-xs font-semibold text-accent">{t("settings.previewHeading")}</div>
            <p className="mt-1.5 text-xs text-ink-200">{t("settings.previewBody")}</p>
            <table className="mt-2 w-full text-xs">
              <thead>
                <tr className="border-b border-ink-700 text-left text-10 text-ink-400">
                  <th className="py-1 pr-3 font-medium">{t("settings.previewRowLabel")}</th>
                  <th className="py-1 font-medium">{t("settings.uptime")}</th>
                </tr>
              </thead>
              <tbody className="text-ink-200">
                <tr>
                  <td className="py-1 pr-3">{t("settings.previewRowLabel")}</td>
                  <td className="py-1">{t("settings.previewRowValue")}</td>
                </tr>
              </tbody>
            </table>
            <pre className="mt-2 rounded bg-ink-900 px-2 py-1.5 font-mono text-11 text-ink-300 selectable">
              {t("settings.previewMono")}
            </pre>
          </div>
        </div>
        {/* Close-to-tray: a backend behaviour (Go reads it at ✕ time), so
            the toggle lives with the other app-level preferences. */}
        <label className="mt-3 flex items-center gap-2 border-t border-ink-700 pt-3 text-xs text-ink-200">
          <Switch checked={settings.closeToTray} onChange={(v) => set("closeToTray", v)} />
          {t("settings.closeToTray")}
          <span className="text-10 text-ink-400">{t("settings.closeToTrayHint")}</span>
        </label>
      </section>
      )}

      {/* ---------- data ---------- */}
      {section === "data" && (
      <section className="panel p-3">
        <SectionTitle icon={<Database size={13} />} text={t("settings.dataSection")} />
        <div className="space-y-2.5">
          <Row label={t("settings.pageSize")}>
            <input
              className="field !w-28"
              type="number"
              min={10}
              max={1000000}
              step={1000}
              value={settings.pageSize}
              onChange={(e) => set("pageSize", Number(e.target.value))}
            />
          </Row>
          <Row label={t("settings.maxScan")}>
            <input
              className="field !w-32"
              type="number"
              min={1000}
              max={1000000}
              step={1000}
              value={settings.maxScan}
              onChange={(e) => set("maxScan", Number(e.target.value))}
            />
          </Row>
          <label className="flex items-center gap-2 text-xs text-ink-200">
            <input
              type="checkbox"
              checked={settings.showInternal}
              onChange={(e) => set("showInternal", e.target.checked)}
            />
            {t("settings.showInternal")}
          </label>
        </div>

        {/* backup / restore: one file carries connections, registries,
            connect clusters, ksqlDB servers, local schemas and preferences
            (passwords stay in the OS credential store and are NOT included) */}
        <div className="mt-4 border-t border-ink-700 pt-3">
          <SectionTitle icon={<Database size={13} />} text={t("settings.backupSection")} />
          <div className="flex items-center gap-2">
            <button
              className="btn flex items-center gap-1.5 text-xs"
              onClick={() => void exportAll()}
            >
              <Download size={13} /> {t("settings.backupExport")}
            </button>
            <button
              className="btn flex items-center gap-1.5 text-xs"
              onClick={() => void importAll()}
            >
              <Upload size={13} /> {t("settings.backupImport")}
            </button>
          </div>
          <p className="mt-2 text-10 text-ink-500">{t("settings.backupHint")}</p>
        </div>
      </section>
      )}

      {/* ---------- version & updates / about ---------- */}
      {section === "updates" && <UpdateSection settings={settings} set={set} />}
      {section === "about" && <AboutSection />}

      {section !== "about" && (
        <div className="flex items-center justify-end gap-2 text-10 text-ink-500">
          {t("settings.autoSaved")}
        </div>
      )}
      </div>
    </div>
  );
}

type SectionId = "appearance" | "data" | "updates" | "about";

// labelKey resolved at render time (locale switches must take effect
// without remounting the app).
const SECTIONS: { id: SectionId; icon: React.ReactNode; labelKey: string }[] = [
  { id: "appearance", icon: <SlidersHorizontal size={13} />, labelKey: "settings.appearance" },
  { id: "data", icon: <Database size={13} />, labelKey: "settings.dataSection" },
  { id: "updates", icon: <Tag size={13} />, labelKey: "settings.updates" },
  { id: "about", icon: <Info size={13} />, labelKey: "settings.about" },
];

// fontOptionLabel renders "名称 · 许可". Uninstalled open-source picks are
// FILTERED OUT of the list entirely (user call: 要用户自己安装那就算了) —
// the only exception is the currently-saved value, which stays visible with
// an 未安装 marker so the saved setting still renders and can be changed.
function fontOptionLabel(
  f: FontPreset,
  available: boolean | undefined,
  t: (key: string) => string,
): string {
  const lic = f.license ? ` · ${f.license}` : "";
  const base = f.label || f.family;
  if (f.shipped || available === undefined || available) {
    return `${base}${lic}`;
  }
  return `${base}${lic} · ${t("settings.fontMissing")}`;
}

// installedOnly filters a preset list to fonts that actually render on this
// machine (shipped + detected-installed). The current saved value always
// survives the filter — dropping it would blank the Select.
function installedOnly(
  presets: FontPreset[],
  availability: Record<string, boolean>,
  currentValue: string,
): FontPreset[] {
  return presets.filter(
    (f) => f.shipped || availability[f.key] || f.key === currentValue,
  );
}
