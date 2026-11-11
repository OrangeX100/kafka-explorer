import { useLayoutEffect, useRef } from "react";

// GlidingTabs: navigation/tabs spec (ui-motion) adapted to the project's
// dark theme. The gliding pill measures the active button via rects (zero
// re-render — direct style writes), slides with the shared spring token,
// ArrowLeft/Right rove, and prefers-reduced-motion snaps instantly.
//
// Liquid morph (the "phone bottom-nav" feel): on a tab CHANGE the pill
// plays two phases — first STRETCH to span both the old and the new button
// (150ms ease-out), then CONTRACT onto the new button (200ms spring). The
// intermediate stretch is what reads as a liquid droplet travelling between
// tabs instead of a plain slide. Initial mount and resize snap instantly.
export function GlidingTabs({
  tabs,
  value,
  onChange,
  small,
}: {
  tabs: { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
  small?: boolean;
}) {
  const pillRef = useRef<HTMLDivElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const prevValue = useRef<string>(value);

  const rectOf = (val: string) => {
    const shell = shellRef.current;
    if (!shell) return null;
    const btn = shell.querySelector<HTMLButtonElement>(`[data-value="${CSS.escape(val)}"]`);
    if (!btn) return null;
    const shellRect = shell.getBoundingClientRect();
    const btnRect = btn.getBoundingClientRect();
    return { x: btnRect.left - shellRect.left, w: btnRect.width };
  };

  const place = (animate: boolean) => {
    const pill = pillRef.current;
    const target = rectOf(value);
    if (!pill || !target) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!animate || reduced) {
      pill.style.transition = "none";
      pill.style.transform = `translate3d(${target.x}px, 0, 0)`;
      pill.style.width = `${target.w}px`;
      void pill.offsetHeight; // commit the jump before restoring transitions
      pill.style.transition = "";
      prevValue.current = value;
      return;
    }

    const prev = rectOf(prevValue.current);
    prevValue.current = value;
    if (!prev || prev.x === target.x) {
      // same slot (resize/first paint): plain spring, no liquid morph
      pill.style.transform = `translate3d(${target.x}px, 0, 0)`;
      pill.style.width = `${target.w}px`;
      return;
    }

    // Liquid morph via WAAPI: single animation, three keyframes — old slot,
    // a STRETCHED span that overshoots the target width (the droplet is
    // visibly fatter than either tab — adjacent tabs span ≈ target width,
    // so without the overshoot the morph is imperceptible), then the target
    // slot. Per-keyframe easing: fast launch, springy settle. WAAPI overrides
    // the CSS transition entirely and self-cleans.
    const spanX = Math.min(prev.x, target.x);
    const spanW = Math.max(prev.x + prev.w, target.x + target.w) - spanX;
    const midW = Math.max(spanW, target.w) + 18;
    pill.style.transform = "";
    const anim = pill.animate(
      [
        { transform: `translate3d(${prev.x}px, 0, 0)`, width: `${prev.w}px`, easing: "cubic-bezier(0.3, 0.9, 0.4, 1)" },
        { transform: `translate3d(${spanX - 9}px, 0, 0)`, width: `${midW}px`, offset: 0.55, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
        { transform: `translate3d(${target.x}px, 0, 0)`, width: `${target.w}px` },
      ],
      { duration: 340, fill: "forwards" },
    );
    anim.finished.then(() => {
      // Commit the final geometry to inline style and drop the fill, so a
      // concurrent resize place(false) isn't fought by a persisting fill.
      if (!pillRef.current) return;
      pill.style.transform = `translate3d(${target.x}px, 0, 0)`;
      pill.style.width = `${target.w}px`;
      anim.cancel();
    }).catch(() => {
      /* cancelled by a newer animation — nothing to commit */
    });
  };

  useLayoutEffect(() => {
    place(true);
    // ResizeObserver keeps the pill glued to its button when fonts finish
    // loading or the window resizes (spec's resize adaptation).
    const ro = new ResizeObserver(() => place(false));
    if (shellRef.current) ro.observe(shellRef.current);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, tabs.length]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const idx = tabs.findIndex((tb) => tb.value === value);
    const next =
      (idx + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length;
    onChange(tabs[next].value);
    shellRef.current
      ?.querySelector<HTMLButtonElement>(`[data-value="${CSS.escape(tabs[next].value)}"]`)
      ?.focus();
  };

  return (
    <div
      ref={shellRef}
      role="tablist"
      className={`ke-tabs-shell ${small ? "ke-tabs-sm" : ""}`}
      onKeyDown={onKeyDown}
    >
      <div ref={pillRef} className="ke-tabs-pill" aria-hidden="true" />
      {tabs.map((tb) => (
        <button
          key={tb.value}
          role="tab"
          aria-selected={value === tb.value}
          data-value={tb.value}
          data-state={value === tb.value ? "active" : "inactive"}
          className="ke-tabs-btn"
          onClick={() => onChange(tb.value)}
        >
          {tb.label}
        </button>
      ))}
    </div>
  );
}
