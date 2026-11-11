import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

// Mechanical stretch switch (ui-motion toggles/switch): press stretches the
// thumb 5px, release glides it across in 300ms; interrupted reversals are
// smooth because every state is a plain CSS transition of width/transform.
export function Switch({
  checked,
  onChange,
  disabled,
  title,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  title?: string;
}) {
  const [pressed, setPressed] = useState(false);
  const reduced = useRef(
    typeof window !== "undefined" && window.matchMedia
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false,
  );
  const extra = pressed && !disabled && !reduced.current ? 5 : 0;
  const travel = 18;

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      title={title}
      className="ke-switch"
      data-checked={checked}
      onPointerDown={(e) => {
        if (e.button === 0 && !disabled) setPressed(true);
      }}
      onPointerUp={() => setPressed(false)}
      onPointerLeave={() => setPressed(false)}
      onKeyDown={(e) => {
        if (e.key === " " && !e.repeat && !disabled) setPressed(true);
      }}
      onKeyUp={() => setPressed(false)}
      onClick={(e) => {
        e.preventDefault();
        if (!disabled) onChange(!checked);
      }}
    >
      <span className="ke-switch-track">
        <span
          className="ke-switch-thumb"
          style={{
            width: 18 + extra,
            transform: `translateX(${checked ? travel - extra : 0}px)`,
          }}
        />
      </span>
    </button>
  );
}

// Display-only switch look for table cells (no editing happens inline).
export function SwitchStatic({ checked, title }: { checked: boolean; title?: string }) {
  return (
    <span className="ke-switch ke-switch-static" data-checked={checked} title={title}>
      <span className="ke-switch-track">
        <span className="ke-switch-thumb" style={{ transform: `translateX(${checked ? 18 : 0}px)` }} />
      </span>
    </span>
  );
}

export interface SelectOption {
  value: string;
  label: string;
}

// Custom dropdown (ui-motion selects/select): panel springs open 150ms,
// chevron flips, selection rolls the value text directionally with a hint
// of blur. Replaces the native <select>, which cannot be themed.
export function Select({
  value,
  options,
  onChange,
  disabled,
  className,
}: {
  value: string;
  options: SelectOption[];
  onChange: (v: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [roll, setRoll] = useState<{ from: string; to: string; dir: "up" | "down" } | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number; w: number; up: boolean } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.value === value);
  const currentIdx = options.findIndex((o) => o.value === value);

  // Portal geometry: fixed coordinates from the trigger rect. A plain
  // absolute dropdown gets CLIPPED by any overflow-auto ancestor (the
  // settings panel clipped the font pickers). Fixed + portal escapes every
  // ancestor; scroll/resize close it (trigger moves, coords go stale).
  const place = useCallback(() => {
    const trigger = rootRef.current?.querySelector(".ke-select-trigger");
    if (!trigger) return;
    const r = trigger.getBoundingClientRect();
    const estimatedH = Math.min(options.length * 30 + 8, 280);
    const up = r.bottom + estimatedH > window.innerHeight - 8 && r.top - estimatedH > 8;
    setPos({
      x: Math.max(4, Math.min(r.left, window.innerWidth - r.width - 4)),
      y: up ? Math.max(4, r.top - estimatedH - 4) : r.bottom + 4,
      w: r.width,
      up,
    });
  }, [options.length]);

  useEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    place();
    // The menu renders in a portal under document.body (outside rootRef),
    // so the outside-close check must whitelist it — otherwise the
    // pointerdown on an option closes the menu before its click event
    // fires and onChange never runs.
    const inMenu = (target: EventTarget | null): boolean => {
      const el = target as Element | null;
      return !!el && typeof el.closest === "function" && !!el.closest(".ke-select-content");
    };
    const onDoc = (e: PointerEvent) => {
      if (inMenu(e.target)) return;
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        rootRef.current?.querySelector("button")?.focus();
      }
    };
    // scrolling INSIDE the scrollable menu must not close it
    const onMove = (e?: Event) => {
      if (e && inMenu(e.target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onDoc);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      document.removeEventListener("pointerdown", onDoc);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [open, place]);

  const choose = (idx: number) => {
    const opt = options[idx];
    if (!opt) return;
    if (opt.value !== value) {
      const prev = current?.label ?? value;
      setRoll({ from: prev, to: opt.label, dir: idx > currentIdx ? "up" : "down" });
      setTimeout(() => setRoll(null), 150);
      onChange(opt.value);
    }
    setOpen(false);
  };

  return (
    <div className={`ke-select ${className ?? ""}`} ref={rootRef}>
      <button
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        className="ke-select-trigger"
        data-state={open ? "open" : "closed"}
        onClick={() => setOpen(!open)}
      >
        <span className="ke-select-value">
          {roll ? (
            <>
              <span key={`x-${roll.from}`} className={`ke-select-roll exit-${roll.dir}`}>
                {roll.from}
              </span>
              <span key={`n-${roll.to}`} className={`ke-select-roll enter-${roll.dir}`}>
                {roll.to}
              </span>
            </>
          ) : (
            <span>{current?.label ?? value}</span>
          )}
        </span>
        <ChevronDown size={14} className="ke-select-chevron" />
      </button>
      {open && pos !== null &&
        createPortal(
          <div
            className="ke-select-content"
            role="listbox"
            data-state="open"
            style={{
              position: "fixed",
              left: pos.x,
              top: pos.y,
              // the trigger may be compact ("50 / 页") while labels are
              // longer — grow to fit content, never smaller than the trigger
              minWidth: pos.w,
              width: "max-content",
              maxWidth: Math.min(pos.w * 2, window.innerWidth - 8),
              transformOrigin: pos.up ? "bottom" : "top",
            }}
          >
            {options.map((o) => (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={o.value === value}
                className="ke-select-item"
                onClick={() => choose(options.indexOf(o))}
              >
                <span>{o.label}</span>
                <Check size={14} className="ke-select-check" />
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
