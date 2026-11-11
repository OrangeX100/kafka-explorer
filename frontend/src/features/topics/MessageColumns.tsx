import { useState } from "react";
import { t } from "../../shared/i18n.js";

// Message table column sizing: per-column px widths are SESSION-ONLY by
// design — a fresh app start returns to the default layout (user request).
// Each header carries a drag handle on its right edge; double-click resets
// that column to auto.
// Default widths: partition/offset/size/headers are narrow data columns;
// timestamp is a fixed-length string; Key and Value stay ELASTIC (null =
// share the remaining space) — they are what a user actually reads.
const DEFAULT_WIDTHS: (number | null)[] = [64, 96, 150, null, null, 72, 72];

export function useMessageColumnWidths() {
  const [widths, setWidths] = useState<(number | null)[]>([...DEFAULT_WIDTHS]);
  const startResize = (i: number) => (e: React.PointerEvent) => {
    e.preventDefault();
    // Pointer capture is belt-and-braces: move/up are tracked on window,
    // so a failed capture (synthetic events in tests) must not break it.
    try {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointerId — window listeners suffice */
    }
    const th = e.currentTarget.parentElement as HTMLElement;
    const startW = widths[i] ?? th.getBoundingClientRect().width;
    const startX = e.clientX;
    const move = (ev: PointerEvent) => {
      const w = Math.min(Math.max(startW + (ev.clientX - startX), 56), 900);
      setWidths((arr) => arr.map((v, j) => (j === i ? Math.round(w) : v)));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  // Double-click resets to the DEFAULT width (not elastic null) — "恢复默认".
  const resetCol = (i: number) => setWidths((arr) => arr.map((v, j) => (j === i ? DEFAULT_WIDTHS[j] : v)));
  return { widths, startResize, resetCol };
}

// Thead for the messages table: labels + per-column resize handles.
export function MessageTableHead({
  widths,
  startResize,
  resetCol,
}: {
  widths: (number | null)[];
  startResize: (i: number) => (e: React.PointerEvent) => void;
  resetCol: (i: number) => void;
}) {
  const labels = [
    t("msg.colPartition"),
    t("msg.colOffset"),
    t("msg.colTimestamp"),
    t("msg.colKey"),
    t("msg.colValue"),
    t("msg.colSize"),
    t("msg.colHeaders"),
  ];
  return (
    <thead>
      <tr>
        {labels.map((label, i) => (
          <th
            key={label}
            className="table-head relative px-2 py-1.5"
            style={widths[i] ? { width: widths[i] } : undefined}
          >
            {label}
            <span
              className="absolute inset-y-0 right-0 z-20 w-1.5 cursor-col-resize hover:bg-accent/40"
              title={t("msg.colResizeHint")}
              onPointerDown={startResize(i)}
              onDoubleClick={() => resetCol(i)}
            />
          </th>
        ))}
      </tr>
    </thead>
  );
}
