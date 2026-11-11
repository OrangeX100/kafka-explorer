import { useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import { useToast } from "../../state/stores.js";
import { t } from "../../shared/i18n.js";

// Adapted from ui-motion messages/toast: spring rise from 16px below
// (420ms snappy), hover pauses the auto-dismiss timer, exit sinks 8px while
// fading (180ms). Desktop adaptation: no swipe-to-dismiss — the close
// button and hover-pause cover dismissal; errors stay until closed.
const AUTO_DISMISS_MS = 4500;


export function ToastHost() {
  const { id, message, kind, clear } = useToast();
  const [phase, setPhase] = useState<"visible" | "exiting" | "gone">("visible");
  const timerRef = useRef<number | null>(null);

  const startTimer = () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    if (kind === "error") return; // errors wait for the close button
    timerRef.current = window.setTimeout(() => setPhase("exiting"), AUTO_DISMISS_MS);
  };

  useEffect(() => {
    if (!message) {
      setPhase("gone");
      return;
    }
    setPhase("visible");
    startTimer();
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (phase === "gone" || !message) return null;

  const finish = () => {
    setPhase("gone");
    clear();
  };

  const icon =
    kind === "error" ? (
      <AlertCircle size={15} className="mt-0.5 shrink-0 text-danger" />
    ) : kind === "ok" ? (
      <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-ok" />
    ) : (
      <Info size={15} className="mt-0.5 shrink-0 text-ink-300" />
    );

  return (
    <div className="pointer-events-none fixed bottom-5 left-1/2 z-50 -translate-x-1/2" aria-live="polite">
      <div
        key={id}
        role="status"
        onAnimationEnd={(e) => {
          const el = e.currentTarget as HTMLElement;
          // The exit animation is the sink-out keyframes on this node.
          if (phase === "exiting" && e.animationName.includes("sink")) {
            el.style.opacity = "0";
            finish();
          }
        }}
        className={`pointer-events-auto flex w-max items-start gap-2.5 rounded border px-3.5 py-2.5 text-xs shadow-xl ${
          phase === "visible" ? "anim-toast" : "anim-sink"
        } ${
          // Solid panel background: a translucent tint let the content
          // underneath bleed through and read as broken rendering.
          kind === "error"
            ? "border-danger/60 bg-ink-850"
            : kind === "ok"
              ? "border-ok/60 bg-ink-850"
              : "border-ink-500 bg-ink-850"
        }`}
        onMouseEnter={() => {
          if (timerRef.current !== null) window.clearTimeout(timerRef.current);
        }}
        onMouseLeave={startTimer}
      >
        {icon}
        {/* Always COMPLETE on a single line: no wrap, no ellipsis, no width
            cap — the panel grows with the content. */}
        <span className="selectable whitespace-nowrap pt-0.5">{message}</span>
        {/* The X exists for persistent errors only — success/info auto-dismiss. */}
        {kind === "error" && (
          <button
            className="ml-1 rounded p-0.5 text-ink-400 transition-colors hover:bg-black/10 hover:text-ink-100"
            aria-label={t("common.close")}
            onClick={() => setPhase("exiting")}
          >
            <X size={13} />
          </button>
        )}
      </div>
    </div>
  );
}
