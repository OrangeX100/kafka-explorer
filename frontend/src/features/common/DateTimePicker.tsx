import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Check, X } from "lucide-react";
import { t } from "../../shared/i18n.js";
import { Select } from "../common/controls.js";

// DateTimePicker: in-house date+time popover styled after ke-select (ink
// tokens, accent highlight, anim-fade). Replaces the native datetime-local
// whose calendar popup cannot be themed and whose value committed on every
// click. The panel is explicit-confirm: pick a day, adjust time, then
// 确定 — outside click / ✕ discards the draft.

// Month/weekday names come from locale (| split) — en users saw 1月/周一.
const MONTHS = () => t("date.months").split("|");
const WEEK_DAYS = () => t("date.weekdays").split("|");

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

export function DateTimePicker({
  value,
  onChange,
  placeholder,
  className,
}: {
  value: number | null; // epoch ms; null = not set
  onChange: (ms: number | null) => void;
  placeholder?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const now = new Date();
  const d = value !== null ? new Date(value) : null;
  const [viewY, setViewY] = useState(d?.getFullYear() ?? now.getFullYear());
  const [viewM, setViewM] = useState(d?.getMonth() ?? now.getMonth());
  // draft day/time inside the panel; committed on 确定
  const [selDay, setSelDay] = useState<number | null>(d?.getDate() ?? null);
  const [selHour, setSelHour] = useState(d?.getHours() ?? 9);
  const [selMin, setSelMin] = useState(d?.getMinutes() ?? 0);

  useEffect(() => {
    if (!open) return;
    const src = value !== null ? new Date(value) : new Date();
    setViewY(src.getFullYear());
    setViewM(src.getMonth());
    setSelDay(value !== null ? src.getDate() : null);
    setSelHour(src.getHours());
    setSelMin(src.getMinutes());
  }, [open, value]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  const grid = useMemo(() => {
    const first = new Date(viewY, viewM, 1);
    // Monday-first offset (一 = 0 … 日 = 6)
    const lead = (first.getDay() + 6) % 7;
    const daysInMonth = new Date(viewY, viewM + 1, 0).getDate();
    const cells: (number | null)[] = Array(lead).fill(null);
    for (let day = 1; day <= daysInMonth; day++) cells.push(day);
    while (cells.length % 7 !== 0) cells.push(null);
    return cells;
  }, [viewY, viewM]);

  const commit = () => {
    if (selDay === null) return;
    const ms = new Date(viewY, viewM, selDay, selHour, selMin).getTime();
    onChange(ms);
    setOpen(false);
  };

  const triggerLabel =
    value !== null
      ? `${d!.getFullYear()}-${pad2(d!.getMonth() + 1)}-${pad2(d!.getDate())} ${pad2(d!.getHours())}:${pad2(d!.getMinutes())}`
      : "";

  const sameDay = (day: number) =>
    value !== null &&
    d !== null &&
    d.getFullYear() === viewY &&
    d.getMonth() === viewM &&
    d.getDate() === day;

  return (
    <div className={`relative ${className ?? ""}`} ref={rootRef}>
      <button
        type="button"
        className={`field flex items-center justify-between gap-1.5 text-left ${value === null ? "text-ink-400" : ""}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={value === null ? "" : "font-mono"}>{triggerLabel || placeholder || "—"}</span>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`flex-none transition-transform duration-150 ${open ? "rotate-180" : ""}`}
          aria-hidden="true"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      <div
        className={`absolute left-0 top-[calc(100%+4px)] z-50 w-72 rounded-lg border border-ink-700 bg-ink-900 p-2.5 shadow-lg shadow-black/40 ${
          open ? "anim-fade" : "hidden"
        }`}
      >
        {/* month navigation */}
        <div className="mb-1.5 flex items-center justify-between">
          <button
            type="button"
            className="flex h-6 w-6 items-center justify-center rounded text-ink-300 hover:bg-ink-800 hover:text-ink-100"
            onClick={() => {
              if (viewM === 0) {
                setViewM(11);
                setViewY((y) => y - 1);
              } else {
                setViewM((m) => m - 1);
              }
            }}
          >
            <ChevronLeft size={14} />
          </button>
          <span className="text-xs font-medium text-ink-100">
            {viewY} {t("date.year")} {MONTHS()[viewM]}
          </span>
          <button
            type="button"
            className="flex h-6 w-6 items-center justify-center rounded text-ink-300 hover:bg-ink-800 hover:text-ink-100"
            onClick={() => {
              if (viewM === 11) {
                setViewM(0);
                setViewY((y) => y + 1);
              } else {
                setViewM((m) => m + 1);
              }
            }}
          >
            <ChevronRight size={14} />
          </button>
        </div>
        {/* weekday header + day grid */}
        <div className="grid grid-cols-7 text-center text-10 text-ink-400">
          {WEEK_DAYS().map((w) => (
            <span key={w} className="py-0.5">
              {w}
            </span>
          ))}
        </div>
        <div className="grid grid-cols-7 text-center">
          {grid.map((day, i) =>
            day === null ? (
              <span key={`e${i}`} />
            ) : (
              <button
                type="button"
                key={`d${day}`}
                className={`mx-auto my-px flex h-7 w-7 items-center justify-center rounded text-xs ${
                  selDay === day
                    ? "bg-accent font-medium text-white"
                    : sameDay(day)
                      ? "border border-accent/60 text-accent"
                      : "text-ink-200 hover:bg-ink-800"
                }`}
                onClick={() => setSelDay(day)}
              >
                {day}
              </button>
            ),
          )}
        </div>
        {/* time row */}
        <div className="mt-1.5 flex items-center gap-1.5 border-t border-ink-700 pt-1.5">
          <span className="text-10 text-ink-400">{t("date.time")}</span>
          <Select
            className="w-16"
            value={String(selHour)}
            options={Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: pad2(h) }))}
            onChange={(v) => setSelHour(Number(v))}
          />
          <span className="text-ink-400">:</span>
          <Select
            className="w-16"
            value={String(selMin)}
            options={Array.from({ length: 60 }, (_, m) => ({ value: String(m), label: pad2(m) }))}
            onChange={(v) => setSelMin(Number(v))}
          />
          <div className="flex-1" />
          <button
            type="button"
            className="btn !px-1.5 !text-10"
            title={t("common.close")}
            onClick={() => setOpen(false)}
          >
            <X size={12} />
          </button>
        </div>
        {/* footer: confirm / clear */}
        <div className="mt-1 flex items-center justify-between border-t border-ink-700 pt-1.5">
          <button
            type="button"
            className="btn !px-2 !text-10"
            onClick={() => {
              setSelDay(null);
              onChange(null);
              setOpen(false);
            }}
          >
            {t("common.clear")}
          </button>
          <button
            type="button"
            className="btn btn-accent flex items-center gap-1 !px-2.5 !text-11"
            disabled={selDay === null}
            onClick={commit}
          >
            <Check size={13} /> {t("common.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
