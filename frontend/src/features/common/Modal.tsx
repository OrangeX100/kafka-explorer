import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

// Adapted from ui-motion overlays/dialog: spring rise-in (400ms snappy from
// translateY(8px) scale(0.96)), fast sink-out exit (160ms), blurred backdrop,
// Escape/overlay dismiss, Tab focus trap.
//
// React lifecycle (范式 B): `open` here means "parent wants it closed".
// We keep the node mounted through the exit animation (data-state=closing)
// and only then invoke onClose, so the parent's conditional render never
// clips the exit transition.
interface ModalProps {
  title: ReactNode;
  danger?: boolean;
  width?: number;
  onClose: () => void; // fired after the exit animation finished
  // lockClose: ignore every dismissal (✕/Escape/backdrop) while true —
  // used by dialogs with a long-running operation whose backend call has
  // no cancellation (e.g. export): closing would orphan the walk (045 round-5).
  lockClose?: boolean;
  children: (close: () => void) => ReactNode;
}

export function Modal({ title, danger, width = 440, onClose, lockClose, children }: ModalProps) {
  const [phase, setPhase] = useState<"open" | "closing">("open");
  const panelRef = useRef<HTMLDivElement>(null);
  const closedRef = useRef(false);

  // Programmatic close from dialog code (children' close): NOT gated by
  // lockClose. lockClose exists to stop USER dismissal (✕/Escape/backdrop)
  // during a long-running operation — but a dialog that calls close() after
  // its own operation SUCCEEDED must actually close, even while the busy
  // state is still rendering true. The old behavior (close also gated by
  // lockClose) deadlocked exactly that sequence: run() set busy=true, the
  // API resolved, close() hit `lockClose=true` and returned, then the
  // finally-block reset busy — leaving the dialog open forever with the
  // operation already done (user re-clicks = duplicate imports).
  const forceClose = () => {
    if (closedRef.current) return;
    closedRef.current = true;
    setPhase("closing");
  };
  const close = () => {
    if (lockClose) return;
    forceClose();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (phase !== "open") return;
      if (e.key === "Escape") {
        e.stopPropagation();
        if (lockClose) return;
        close();
        return;
      }
      if (e.key === "Tab" && panelRef.current) {
        // Focus trap: cycle within the panel.
        const focusables = Array.from(
          panelRef.current.querySelectorAll<HTMLElement>(
            "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])"
          )
        ).filter((el) => !el.hasAttribute("disabled"));
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // lockClose must be a dep: onKey closes over close()/lockClose, and a
    // dialog that flips lockClose mid-life (busy gate) otherwise keeps the
    // stale false — Escape dismisses through the lock mid-operation.
  }, [phase, lockClose]);

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center p-4"
      data-state={phase}
      role="dialog"
      aria-modal="true"
    >
      {/* Backdrop: blurred dim; click-to-dismiss. */}
      <div
        className={`absolute inset-0 bg-black/50 backdrop-blur-[7px] ${
          phase === "open" ? "anim-fade" : "opacity-0"
          // exit fade uses the same 160ms window via inline transition below
        }`}
        style={
          phase === "closing"
            ? { transition: "opacity 160ms var(--ease-exit)" }
            : undefined
        }
        onClick={close}
        aria-hidden="true"
        data-locked={lockClose ? "true" : undefined}
      />
      <div
        ref={panelRef}
        className={`panel relative z-10 max-h-[86vh] overflow-y-auto shadow-2xl ${
          danger ? "border-danger/40" : ""
        } ${phase === "open" ? "anim-rise" : "anim-sink"}`}
        style={{ width }}
        onAnimationEnd={(e) => {
          if (e.target === e.currentTarget && phase === "closing") {
            onClose();
          }
        }}
      >
        <div
          className={`border-b px-4 py-2.5 text-sm font-medium ${
            danger ? "border-ink-700 text-danger" : "border-ink-700"
          }`}
        >
          {title}
        </div>
        <div className="px-4 py-3">{children(forceClose)}</div>
      </div>
    </div>
  );
}
