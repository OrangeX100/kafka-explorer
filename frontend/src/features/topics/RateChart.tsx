// RateChart: messages-per-time-bucket histogram for a topic (
// Visualization tab). Data comes from a bounded timestamp scan
// (TopicRateHistogram); the chart is dependency-free SVG — an area line
// with a hover crosshair reading.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { topicApi, friendlyError } from "../../shared/api.js";
import { t } from "../../shared/i18n.js";
import { Select } from "../common/controls.js";
import type { RateScanWindow } from "../../shared/contracts-admin.js";
import { Check } from "lucide-react";
import { DateTimePicker } from "../common/DateTimePicker.js";
import type { RateBucket } from "../../shared/contracts-admin.js";

const RANGES: { label: string; ms: number }[] = [
  { label: "1h", ms: 3600_000 },
  { label: "6h", ms: 6 * 3600_000 },
  { label: "24h", ms: 24 * 3600_000 },
  { label: "7d", ms: 7 * 24 * 3600_000 },
];

const fmtTime = (ms: number) => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

export function RateChart({
  connectionId,
  topic,
  partitions,
}: {
  connectionId: string;
  topic: string;
  partitions: { id: number; messageCount: number }[];
}) {
  // "All" = partition -1 (aggregate every partition); otherwise a single
  // partition id — matching the Partition selector.
  const [partition, setPartition] = useState(-1);
  // Start point ( Messages dropdown): Newest (last rangeMs) / Oldest
  // (scan the whole log) / From Timestamp / From Specific Offset.
  const [startMode, setStartMode] = useState("newest");
  // Draft (the input) vs applied (what the chart actually scanned): the
  // native datetime picker commits on every click, which re-ran the scan
  // mid-selection — the apply button makes the scan an explicit action.
  const [customStart, setCustomStart] = useState("");
  const [appliedCustom, setAppliedCustom] = useState<number | null>(null);
  const [rangeMs, setRangeMs] = useState(24 * 3600_000);
  const [data, setData] = useState<RateBucket[] | null>(null);
  const [scanned, setScanned] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  // actual scan start (ms) — the footer range hint reads this, so a
  // timestamp/offset start never mislabels itself with the 24h chip text
  const [fromMs, setFromMs] = useState(Date.now() - 24 * 3600_000);

  // Stale-response guard: a slow 7d scan superseded by a fast 1h one used
  // to overwrite the chart with the OLD range while the chips showed the
  // new one (045 batch-3 round).
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setError(null);
    // timestamp anchor: newest = last rangeMs window; oldest = whole log;
    // timestamp = the confirmed picker value
    let fromMs = Date.now() - rangeMs;
    if (startMode === "oldest") fromMs = 0;
    if (startMode === "timestamp" && appliedCustom !== null && appliedCustom > 0) fromMs = appliedCustom;
    // offset anchor: forward scan FROM the confirmed offset (backend filters
    // records below it); window derives from the scanned records themselves
    const win: RateScanWindow =
      startMode === "offset" && appliedCustom !== null && appliedCustom >= 0
        ? { fromMs: 0, fromOffset: appliedCustom, byOffset: true }
        : { fromMs, fromOffset: 0, byOffset: false };
    setFromMs(win.fromMs);
    try {
      // wails multi-return bindings resolve to a tuple [buckets, scanned]
      const [buckets, scannedOut] = await topicApi.rateHistogram(connectionId, topic, win, 60, partition);
      if (seq !== loadSeq.current) return; // a newer scan won
      setData(buckets ?? []);
      setScanned(scannedOut ?? 0);
    } catch (err) {
      if (seq === loadSeq.current) setError(friendlyError(err));
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [connectionId, topic, rangeMs, partition, startMode, appliedCustom]);

  useEffect(() => {
    void load();
  }, [load]);

  const chart = useMemo(() => {
    if (!data || data.length === 0) return null;
    const W = 860;
    const H = 300;
    const padL = 46;
    const padB = 24;
    const padT = 10;
    const maxCount = Math.max(1, ...data.map((b) => b.count));
    const bw = (W - padL) / data.length;
    const pts = data.map((b, i) => ({
      x: padL + i * bw + bw / 2,
      y: padT + (1 - b.count / maxCount) * (H - padT - padB),
      b,
    }));
    const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
    const area = `${line} L${pts[pts.length - 1].x.toFixed(1)},${H - padB} L${pts[0].x.toFixed(1)},${H - padB} Z`;
    const gridY = [0, 0.25, 0.5, 0.75, 1].map((f) => padT + f * (H - padT - padB));
    return { W, H, padL, padT, padB, pts, line, area, gridY, maxCount, bw };
  }, [data]);

  const tickLabel = (ms: number) => fmtTime(ms);

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar as TWO stacked rows (start-point row / partition+range row).
          A single flex line with many clusters was the source of the user's
          "overlapping" report: under DPI/font-size combinations the row ran
          out of width and flex compression pulled neighbouring children
          together. Two fixed rows can never cross into each other. */}
      <div className="flex flex-none flex-col border-b border-ink-700 bg-ink-900 px-2 py-1.5">
        {/* row 1: start point */}
        <div className="flex flex-none items-center gap-1.5">
          <span className="flex-none text-10 text-ink-400">{t("viz.messagesLabel")}</span>
          <div className="w-36 flex-none">
            <Select
              className="w-full"
              value={startMode}
              options={[
                { value: "newest", label: t("viz.startNewest") },
                { value: "oldest", label: t("viz.startOldest") },
                { value: "timestamp", label: t("viz.startTimestamp") },
                { value: "offset", label: t("viz.startOffset") },
              ]}
              onChange={setStartMode}
            />
          </div>
          {startMode === "timestamp" && (
            <DateTimePicker
              className="!w-44 flex-none"
              value={appliedCustom}
              onChange={(ms) => setAppliedCustom(ms)}
              placeholder={t("viz.startTimestamp")}
            />
          )}
          {startMode === "offset" && (
            <>
              <input
                className="field !w-24 flex-none !py-1 font-mono"
                placeholder={t("viz.startOffsetPh")}
                value={customStart}
                onChange={(e) => setCustomStart(e.target.value)}
              />
              <button
                className="btn flex-none !px-2"
                title={t("viz.applyTime")}
                onClick={() => setAppliedCustom(Number(customStart))}
              >
                <Check size={14} />
              </button>
            </>
          )}
        </div>
        {/* row 2: partition + range chips (newest only) + refresh */}
        <div className="mt-1.5 flex flex-none items-center gap-1.5">
          <span className="flex-none text-10 text-ink-400">{t("viz.partitionLabel")}</span>
          <div className="w-32 flex-none">
            <Select
              className="w-full"
              value={String(partition)}
              options={[
                { value: "-1", label: t("viz.partitionAll") },
                ...partitions.map((p) => ({
                  value: String(p.id),
                  label: `${t("topic.partition")} ${p.id} (${p.messageCount})`,
                })),
              ]}
              onChange={(v) => setPartition(Number(v))}
            />
          </div>
          <div className="mx-1 h-4 w-px bg-ink-600" />
          {startMode === "newest" && (
            <div className="flex flex-none items-center gap-1">
              {RANGES.map((r) => (
                <button
                  key={r.label}
                  className={`btn !px-2 !text-11 ${rangeMs === r.ms ? "btn-accent" : ""}`}
                  onClick={() => setRangeMs(r.ms)}
                >
                  {r.label}
                </button>
              ))}
              <button className="btn !px-2" onClick={() => void load()} title={t("topics.refresh")}>
                ↻
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {loading && data === null && <div className="p-3 text-xs text-ink-400">{t("common.loading")}</div>}
        {error && <div className="rounded border border-danger/40 bg-danger/10 px-2.5 py-2 text-xs text-ink-100">{error}</div>}
        {!loading && !error && chart && (
          <>
            <svg
              viewBox={`0 0 ${chart.W} ${chart.H}`}
              className="w-full select-none"
              onMouseMove={(e) => {
                const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
                const x = ((e.clientX - rect.left) / rect.width) * chart.W;
                const idx = Math.floor((x - chart.padL) / chart.bw);
                setHover(idx >= 0 && idx < (data?.length ?? 0) ? idx : null);
              }}
              onMouseLeave={() => setHover(null)}
            >
              {chart.gridY.map((y, i) => (
                <g key={i}>
                  <line x1={chart.padL} x2={chart.W} y1={y} y2={y} stroke="rgb(var(--ink-800))" strokeWidth={1} />
                  <text x={4} y={y + 4} fill="rgb(var(--ink-400))" fontSize={10}>
                    {Math.round(chart.maxCount * (1 - i / 4))}
                  </text>
                </g>
              ))}
              <path d={chart.area} fill="rgb(var(--accent) / 0.15)" stroke="none" />
              <path d={chart.line} fill="none" stroke="rgb(var(--accent))" strokeWidth={1.5} />
              {hover !== null && chart.pts[hover] && (
                <g>
                  <line
                    x1={chart.pts[hover].x}
                    x2={chart.pts[hover].x}
                    y1={chart.padT}
                    y2={chart.H - chart.padB}
                    stroke="rgb(var(--ink-400))"
                    strokeDasharray="3 3"
                  />
                  <circle cx={chart.pts[hover].x} cy={chart.pts[hover].y} r={3} fill="rgb(var(--accent))" />
                </g>
              )}
              <text x={chart.padL} y={chart.H - 6} fill="rgb(var(--ink-400))" fontSize={10}>
                {tickLabel(data?.[0]?.startMs ?? 0)}
              </text>
              <text x={chart.W} y={chart.H - 6} fill="rgb(var(--ink-400))" fontSize={10} textAnchor="end">
                {tickLabel((data?.[data.length - 1]?.startMs ?? 0) + rangeMs / (data?.length ?? 1))}
              </text>
            </svg>
            {hover !== null && data?.[hover] && (
              <div className="mt-1 text-11 text-ink-300">
                {fmtTime(data[hover].startMs)} — {data[hover].count} {t("viz.messages")}
              </div>
            )}
            <div className="mt-1 text-10 text-ink-500">
              {t("viz.scanned", String(scanned ?? 0))}
              {" · "}
              {startMode === "newest"
                ? t("viz.windowHint", String(RANGES.find((r) => r.ms === rangeMs)?.label ?? ""))
                : t("viz.windowFrom", fmtTime(fromMs))}
            </div>
          </>
        )}
        {!loading && !error && (!data || data.every((b) => b.count === 0)) && data !== null && (
          <div className="p-3 text-xs text-ink-400">{t("viz.empty")}</div>
        )}
      </div>
    </div>
  );
}
