import { useState } from "react";
import { classifyError, errorHints } from "../../shared/api.js";
import { t } from "../../shared/i18n.js";

// ErrorHint: the user-friendly failure block used by list load banners and
// dialogs. Structure: classified title → how-to-fix bullets (per error
// class, from the locales) → retry/dismiss actions → collapsible raw detail.
// The raw transport error is never dropped, only demoted to an opt-in
// expansion for support/diagnosis.
export function ErrorHint({
  error,
  onRetry,
  onDismiss,
  compact,
}: {
  error: unknown;
  onRetry?: () => void;
  onDismiss?: () => void;
  compact?: boolean;
}) {
  const { key, detail } = classifyError(error);
  const hints = errorHints(key);
  const [open, setOpen] = useState(false);
  return (
    <div
      className={`rounded border border-danger/30 bg-danger/5 text-xs ${
        compact ? "px-2.5 py-2" : "px-3 py-2.5"
      }`}
    >
      <div className="flex items-center gap-1.5 font-medium text-danger">{t(key)}</div>
      {!compact && hints.length > 0 && (
        <ul className="mt-1.5 space-y-0.5">
          {hints.map((h) => (
            <li key={h} className="flex gap-1.5 text-11 leading-relaxed text-ink-300">
              <span className="mt-0.5 h-1 w-1 flex-none rounded-full bg-ink-500" />
              {h}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {onRetry && (
          <button className="btn" onClick={onRetry}>
            {t("load.retry")}
          </button>
        )}
        {onDismiss && (
          <button className="btn" onClick={onDismiss}>
            {t("common.close")}
          </button>
        )}
        <button
          className="text-11 text-ink-400 underline decoration-ink-600 underline-offset-2 transition-colors hover:text-ink-200"
          onClick={() => setOpen(!open)}
        >
          {open ? t("common.detailsHide") : t("common.details")}
        </button>
      </div>
      {open && (
        <pre className="mt-1.5 max-h-28 overflow-auto whitespace-pre-wrap rounded bg-ink-900 px-2 py-1.5 text-10 leading-relaxed text-ink-400">
          {detail}
        </pre>
      )}
    </div>
  );
}
