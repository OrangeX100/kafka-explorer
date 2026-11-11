import { useEffect, useRef, useState } from "react";

export type MorphStatus = "loading" | "done" | "error";

// Three bouncing dots = loading; the same four persistent paths morph into
// a check / X on result (loaders/morph-loader spec, Dots form). The dots
// are tiny stroked segments (`M x 12h0.01`, width 4 = round dots) so the
// `d`-transition morph into the result glyph stays intact.
const SHAPES: Record<MorphStatus, [string, string, string, string]> = {
  loading: [
    "M6 12h0.01",
    "M12 12h0.01",
    "M18 12h0.01",
    "M12 12h0.01",
  ],
  done: ["M5 12l5 5L20 7", "M5 12l5 5L20 7", "M5 12l5 5L20 7", "M5 12l5 5L20 7"],
  error: ["M6 6l12 12", "M18 6L6 18", "M12 12h0.01", "M12 12h0.01"],
};

// MorphLoader: dots bounce in a staggered wave while loading; on done/error
// the paths morph into the result glyph with a 1→1.14→1 pulse (420ms).
// Chromium-only `transition: d` is fine here — the app ships on WebView2
// (the spec's fallback never triggers).
export function MorphLoader({ status, size = 40 }: { status: MorphStatus; size?: number }) {
  const ds = SHAPES[status];
  const [pulse, setPulse] = useState(false);
  const prev = useRef<MorphStatus>("loading");

  useEffect(() => {
    if (status !== "loading" && prev.current === "loading") {
      setPulse(true);
      const t = setTimeout(() => setPulse(false), 420);
      prev.current = status;
      return () => clearTimeout(t);
    }
    prev.current = status;
  }, [status]);

  const color =
    status === "done" ? "rgb(var(--ok))" : status === "error" ? "rgb(var(--danger))" : "rgb(var(--accent))";

  return (
    <span className={`morph-loader ${pulse ? "morph-pulse" : ""}`} data-status={status} role="status">
      <svg viewBox="0 0 24 24" width={size} height={size} fill={status === "loading" ? color : "none"} stroke={color} strokeLinecap="round" aria-hidden="true">
        {ds.map((d, i) => (
          <path
            key={i}
            className={`morph-path ${status === "loading" && i < 3 ? "morph-dot" : ""}`}
            d={d}
            strokeWidth={status === "loading" ? 3.4 : 2.5}
            style={status === "loading" && i < 3 ? { animationDelay: `${i * 0.15}s` } : undefined}
          />
        ))}
      </svg>
    </span>
  );
}
