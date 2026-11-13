import { useEffect, useRef, useState } from "react";
import { CircleAlert, Copy, Download, ExternalLink, Info, Tag } from "lucide-react";
import { Events } from "@wailsio/runtime";
import { systemApi, friendlyError } from "../../shared/api.js";
import type { AppSettings, AppInfo, UpdateCheck } from "../../shared/contracts-admin.js";
import { t } from "../../shared/i18n.js";
import { useCopy } from "../../shared/useCopy.js";
import { SectionTitle } from "./Section.js";

type Phase = "idle" | "downloading" | "staged" | "installing";

// UpdateSection: the version-update mechanism UI. The repo field
// ("owner/repo") is user-configured and saved with the rest of the
// settings; Check Now runs against the CURRENT field value so the user
// can test before saving. Result renders inline: up-to-date / new
// version with notes + release-page actions / classified friendly error.
export function UpdateSection({
  settings,
  set,
}: {
  settings: AppSettings;
  set: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
}) {
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<UpdateCheck | null>(null);
  const [error, setError] = useState("");
  const copy = useCopy();
  // Auto-update lifecycle (Windows only): idle → downloading (progress
  // events) → staged (install+relaunch button) → installing (app quits,
  // the silent installer takes over). GOOS!=windows never leaves idle.
  const [phase, setPhase] = useState<Phase>("idle");
  const [bytes, setBytes] = useState(0);
  const [total, setTotal] = useState(0);
  const [staged, setStaged] = useState("");
  const reqID = useRef(`u-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  const isWindows = /^windows/i.test(navigator.userAgent);

  const runCheck = async () => {
    setChecking(true);
    setResult(null);
    setError("");
    try {
      setResult(await systemApi.checkUpdate(settings.updateRepo.trim()));
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setChecking(false);
    }
  };

  // Progress + completion events for the staged download (id-filtered so a
  // second About mount ignores a stale stream).
  useEffect(() => {
    const offProgress = Events.On("system:update:progress", (ev: unknown) => {
      const data = (ev as { data?: { id: string; bytes: number; total: number } })?.data;
      if (!data || data.id !== reqID.current) return;
      setBytes(data.bytes);
      setTotal(data.total);
    });
    const offDone = Events.On("system:update:done", (ev: unknown) => {
      const data = (ev as { data?: { id: string; failed: boolean; staged: string; error?: string } })?.data;
      if (!data || data.id !== reqID.current) return;
      setPhase(data.failed ? "idle" : "staged");
      setStaged(data.failed ? "" : data.staged);
      if (data.failed && data.error) setError(data.error);
    });
    return () => {
      offProgress();
      offDone();
    };
  }, []);

  const startDownload = () => {
    if (!result?.assetUrl) return;
    setError("");
    setPhase("downloading");
    setBytes(0);
    setTotal(result.assetSize || 0);
    reqID.current = `u-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    void systemApi.stageUpdate(settings.updateRepo.trim(), result.assetUrl, result.assetSize || 0, reqID.current);
  };

  const cancelDownload = () => {
    void systemApi.cancelUpdate();
    setPhase("idle");
  };

  const installNow = async () => {
    if (!staged) return;
    setPhase("installing");
    try {
      await systemApi.installStaged(staged, true);
      // The app quits right after this; the silent installer takes over.
    } catch (err) {
      setPhase("staged");
      setError(friendlyError(err));
    }
  };

  const pct = total > 0 ? Math.min(100, Math.round((bytes / total) * 100)) : 0;
  const mb = (n: number) => (n / 1024 / 1024).toFixed(1);

  return (
    <section className="panel p-3">
      <SectionTitle icon={<Tag size={13} />} text={t("settings.updates")} />
      <div className="space-y-2.5">
        <label className="flex items-center gap-2 text-xs text-ink-200">
          <input
            type="checkbox"
            checked={settings.autoCheckUpdate}
            onChange={(e) => set("autoCheckUpdate", e.target.checked)}
          />
          {t("settings.autoCheckUpdate")}
        </label>
      </div>

      <div className="mt-3 flex items-center gap-3">
        <button
          className="btn btn-accent"
          disabled={checking}
          onClick={() => void runCheck()}
        >
          {checking ? t("settings.checking") : t("settings.checkNow")}
        </button>
      </div>

      {error && (
        <div className="mt-3 flex items-start gap-2 rounded border border-danger/40 bg-danger/10 px-2.5 py-2 text-xs text-ink-100">
          <CircleAlert size={14} className="mt-0.5 flex-none text-danger" />
          <span className="leading-relaxed">{error}</span>
        </div>
      )}
      {result && (
        <div
          className={`mt-3 rounded border px-2.5 py-2 text-xs ${
            result.hasUpdate ? "border-accent/40 bg-accent/10 text-ink-100" : "border-ok/40 bg-ok/10 text-ink-100"
          }`}
          data-testid="update-result"
        >
          <div className="flex items-center gap-2 font-medium">
            <Info size={14} className={result.hasUpdate ? "text-accent" : "text-ok"} />
            {result.hasUpdate ? t("settings.updateAvailable") : t("settings.upToDate")}
          </div>
          <div className="mt-1 text-ink-300">
            {t("settings.updateCurrentLatest", result.current, result.latest)}
          </div>
          {result.hasUpdate && result.notes && (
            <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-ink-900 px-2 py-1.5 text-11 leading-relaxed text-ink-300 selectable">
              {result.notes}
            </pre>
          )}
          {result.hasUpdate && result.url && (
            <div className="mt-2 flex items-center gap-2">
              <button className="btn !px-2 !py-0.5 text-11" onClick={() => window.open(result.url, "_blank")}>
                <ExternalLink size={12} /> {t("settings.updateOpenUrl")}
              </button>
              <button className="btn !px-2 !py-0.5 text-11" onClick={() => copy(result.url)}>
                <Copy size={12} /> {t("settings.updateCopyUrl")}
              </button>
            </div>
          )}
          {result.hasUpdate && isWindows && phase === "idle" && !result.assetUrl && (
            // No installer attached to this release (or the check ran while
            // rate-limited): say WHY one-click update is unavailable instead
            // of silently showing only the release-page link.
            <div className="mt-2 rounded border border-warn/40 bg-warn/10 px-2 py-1.5 text-10 leading-relaxed text-warn">
              {t("settings.updateNoAsset")}
            </div>
          )}
          {result.hasUpdate && isWindows && phase === "idle" && result.assetUrl && (
            <button className="btn btn-accent mt-2" onClick={startDownload}>
              <Download size={12} /> {t("settings.updateDownload")}
            </button>
          )}
          {phase === "downloading" && (
            <div className="mt-2">
              <div className="h-1.5 overflow-hidden rounded bg-ink-800">
                <div className="h-full bg-accent transition-[width] duration-150" style={{ width: `${pct}%` }} />
              </div>
              <div className="mt-1 flex items-center justify-between text-10 text-ink-400">
                <span>{t("settings.updateDownloading")}</span>
                <span>
                  {mb(bytes)}/{mb(total)} MB · {pct}%
                </span>
                <button className="btn !px-1.5 !py-0 text-10" onClick={cancelDownload}>
                  {t("settings.updateCancel")}
                </button>
              </div>
            </div>
          )}
          {phase === "staged" && (
            <div className="mt-2 rounded border border-ok/40 bg-ok/10 px-2.5 py-2 text-11 text-ink-100">
              {t("settings.updateStaged")}
              <button className="btn btn-accent ml-2 !px-2 !py-0.5" onClick={() => void installNow()}>
                {t("settings.updateInstall")}
              </button>
            </div>
          )}
          {phase === "installing" && (
            <div className="mt-2 text-11 text-ink-300">{t("settings.updateInstalling")}</div>
          )}
        </div>
      )}
    </section>
  );
}

// AboutSection: build identity (version, commit, Go runtime, platform)
// plus the local paths users need for bug reports (data dir, log file),
// each copyable.
export function AboutSection() {
  const [about, setAbout] = useState<AppInfo | null>(null);
  const copy = useCopy();
  const askedRef = useRef(false);

  useEffect(() => {
    if (askedRef.current) return;
    askedRef.current = true;
    systemApi
      .info()
      .then(setAbout)
      .catch(() => setAbout(null));
  }, []);

  return (
    <section className="panel p-3">
      <SectionTitle icon={<Info size={13} />} text={t("settings.about")} />
      <div className="flex items-center gap-3">
        <img src="/appicon.png" alt="" className="h-10 w-10" draggable={false} />
        <div>
          <div className="text-sm font-semibold text-ink-100">Kafka Explorer</div>
          <div className="mt-0.5 flex items-center gap-2 text-11 text-ink-300">
            <span className="rounded bg-accent/15 px-1.5 py-0.5 font-mono text-accent">
              v{about?.version ?? "…"}
            </span>
            {about?.commit && <span className="font-mono text-ink-400">{about.commit}</span>}
          </div>
        </div>
      </div>
      <dl className="mt-3 space-y-1.5 text-xs">
        <InfoRow label={t("settings.goVersion")} value={about?.goVersion} />
        <InfoRow label={t("settings.platform")} value={about ? `${about.os}/${about.arch}` : undefined} />
        <InfoRow label={t("settings.dataDir")} value={about?.dataDir} mono copy={copy} />
        <InfoRow label={t("settings.logFile")} value={about?.logFile} mono copy={copy} />
      </dl>
    </section>
  );
}

function InfoRow({
  label,
  value,
  mono,
  copy,
}: {
  label: string;
  value?: string;
  mono?: boolean;
  copy?: (text: string) => void;
}) {
  const shown = value || t("settings.notSet");
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="flex-none text-ink-300">{label}</dt>
      <dd className={`flex min-w-0 items-center gap-1 text-ink-200 ${mono ? "font-mono" : ""}`}>
        <span className="truncate" title={shown}>
          {shown}
        </span>
        {copy && value && (
          <button
            className="flex-none rounded p-0.5 text-ink-400 transition-colors hover:bg-ink-700 hover:text-ink-100"
            title={t("settings.copyPath")}
            onClick={() => copy(value)}
          >
            <Copy size={12} />
          </button>
        )}
      </dd>
    </div>
  );
}
