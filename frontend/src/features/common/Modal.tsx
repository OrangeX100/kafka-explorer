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
  children: (close: () => void) => ReactNode;
}

export function Modal({ title, danger, width = 440, onClose, children }: ModalProps) {
  const [phase, setPhase] = useState<"open" | "closing">("open");
  const panelRef = useRef<HTMLDivElement>(null);
  const closedRef = useRef(false);

  const close = () => {
    if (closedRef.current) return;
    closedRef.current = true;
    setPhase("closing");
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (phase !== "open") return;
      if (e.key === "Escape") {
        e.stopPropagation();
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
  }, [phase]);

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
        <div className="px-4 py-3">{children(close)}</div>
      </div>
    </div>
  );
}
