import {
  ArrowLeftToLine,
  ArrowRightToLine,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Search,
  Send,
  Trash2,
} from "lucide-react";
import { t } from "../../shared/i18n.js";
import { formatNumber } from "../../shared/format.js";
import type { GoToTarget } from "./GoToDialog.js";
import type { TopicDetail } from "../../shared/contracts.js";
import { Select } from "../common/controls.js";

const PAGE_SIZE = 100;

interface MessagesToolbarProps {
  detail: TopicDetail | null;
  // isProtected: mutation buttons hidden + note shown (Kafka __-internal AND
  // ecosystem-managed topics — see shared/kafkaInternal.ts)
  isProtected?: boolean;
  partition: number;
  setPartition: (p: number) => void;
  cursor: "head" | "tail" | { offset: number };
  setCursor: (c: "head" | "tail" | { offset: number }) => void;
  loadPage: (c: "head" | "tail" | { offset: number }, goto?: GoToTarget) => Promise<void>;
  exhausted: boolean;
  loading: boolean;
  // true after a find: the cursor no longer describes the shown window
  pagingSuspended: boolean;
  firstOffset?: number;
  lastOffset?: number;
  pageSize: number;
  onPageSizeChange: (n: number) => void;
  findPattern: string;
  setFindPattern: (v: string) => void;
  useRegex: boolean;
  setUseRegex: (v: boolean) => void;
  scanInfo: number | null;
  decodeOn: boolean;
  setDecodeOn: (v: boolean) => void;
  onOpenGoTo: () => void;
  onOpenGenerate: () => void;
  onOpenImport: () => void;
  onOpenExport: () => void;
  onOpenProduce: () => void;
  onOpenDelete: () => void;
  goPrev: () => void;
  goNext: () => void;
  refresh: () => void;
  runFind: () => Promise<void>;
}

// Toolbar: browse row (partition / go-to / paging / find) and a separate
// ops row (generate / import / export / decode / send / delete). The
// 消息/配置 tabs live in the slim header above (MessagesView), so the
// config page never shows message-page controls. Presentational —
// MessagesView owns the state and request logic.
export function MessagesToolbar({
  detail,
  isProtected,
  partition,
  setPartition,
  cursor,
  setCursor,
  loadPage,
  exhausted,
  loading,
  pagingSuspended,
  firstOffset,
  lastOffset,
  pageSize,
  onPageSizeChange,
  findPattern,
  setFindPattern,
  useRegex,
  setUseRegex,
  scanInfo,
  decodeOn,
  setDecodeOn,
  onOpenGoTo,
  onOpenGenerate,
  onOpenImport,
  onOpenExport,
  onOpenProduce,
  onOpenDelete,
  goPrev,
  goNext,
  refresh,
  runFind,
}: MessagesToolbarProps) {
  return (
    <>
      {/* browse row */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-ink-700 bg-ink-900 px-2 py-1.5">
            <Select
      className="!w-auto"
      value={String(partition)}
      options={(detail?.partitionList ?? []).map((p) => ({
        value: String(p.id),
        label: `${t("topic.partition")} ${p.id} (${formatNumber(p.messageCount)})`,
      }))}
      onChange={(v) => setPartition(Number(v))}
    />
        <span className="mx-1 h-4 w-px bg-ink-600" />
        <button className="btn" onClick={onOpenGoTo}>
          {t("msg.goto")}
        </button>
        <button className="btn" title={t("msg.jumpFirstHint")} onClick={() => { setCursor("head"); void loadPage("head"); }}>
          <ArrowLeftToLine size={13} /> {t("msg.first")}
        </button>
        <button className="btn" title={t("msg.prevHint")} disabled={cursor === "head" || pagingSuspended || loading} onClick={goPrev}>
          <ChevronLeft size={13} /> {t("msg.prev")}
        </button>
        <button className="btn" title={t("msg.nextHint")} disabled={exhausted || pagingSuspended || loading} onClick={goNext}>
          {t("msg.next")} <ChevronRight size={13} />
        </button>
        <button className="btn" title={t("msg.jumpLatestHint")} onClick={() => { setCursor("tail"); void loadPage("tail"); }}>
          {t("msg.latest")} <ArrowRightToLine size={13} />
        </button>
        <button
          className="btn"
          title={t("msg.refreshHint")}
          disabled={loading || pagingSuspended}
          onClick={refresh}
        >
          <RefreshCw size={13} /> {t("msg.refresh")}
        </button>
        {/* window position badge: 最新/最早 are one-shot jumps, not sort
            modes — this badge always says where the window now sits */}
        <span
          className={`rounded px-1.5 py-0.5 text-10 ${
            pagingSuspended
              ? "bg-warn/15 text-warn"
              : cursor === "tail"
                ? "bg-ok/15 text-ok"
                : cursor === "head"
                  ? "bg-accent/15 text-accent"
                  : "bg-ink-800 text-ink-300"
          }`}
          title={t("msg.positionHint")}
        >
          {pagingSuspended
            ? t("msg.positionSearch")
            : cursor === "tail"
              ? t("msg.positionLatest")
              : cursor === "head"
                ? t("msg.positionOldest")
                : typeof cursor === "object" && firstOffset !== undefined && lastOffset !== undefined
                  ? `offset ${formatNumber(firstOffset)}–${formatNumber(lastOffset)}`
                  : typeof cursor === "object"
                    ? `offset ${cursor.offset}`
                    : ""}
        </span>
        {/* per-page size: reads/writes the app setting (same one the
            Settings→数据 page edits), jump back to the newest window so the
            change takes effect immediately */}
        <span className="mx-1 h-4 w-px bg-ink-600" />
        <Select
          className="!w-auto"
          value={String(pageSize)}
          options={[25, 50, 100, 200, 500].map((n) => ({ value: String(n), label: `${n} / ${t("msg.page")}` }))}
          onChange={(v) => onPageSizeChange(Number(v))}
        />
        <span className="mx-1 h-4 w-px bg-ink-600" />
        <input
          className="field !w-52 !py-1"
          placeholder={t("msg.findPlaceholder")}
          value={findPattern}
          onChange={(e) => setFindPattern(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void runFind()}
        />
        <label className="flex items-center gap-1 text-11 text-ink-300">
          <input type="checkbox" checked={useRegex} onChange={(e) => setUseRegex(e.target.checked)} />
          {t("msg.regex")}
        </label>
        <button className="btn" disabled={!findPattern || loading} onClick={() => void runFind()}>
          <Search size={13} /> {t("msg.search")}
        </button>
        {scanInfo !== null && <span className="text-11 text-ink-400">{t("msg.scanned", formatNumber(scanInfo))}</span>}
      </div>

      {/* ops row — separated from browse controls so the danger action
          never wraps into a lonely stray line */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-ink-700 bg-ink-900 px-2 py-1.5">
        <span className="text-10 font-medium uppercase tracking-wide text-ink-400">ops</span>
        {!isProtected && (
          <button className="btn" onClick={onOpenGenerate} title={t("gen.title")}>
            ⚡ {t("gen.title")}
          </button>
        )}
        {!isProtected && (
          <button className="btn" onClick={onOpenImport} title={t("msg.import")}>
            {t("msg.import")}
          </button>
        )}
        <button className="btn" onClick={onOpenExport} title={t("msg.export")}>
          {t("msg.export")}
        </button>
        <span className="mx-1 h-4 w-px bg-ink-600" />
        <label className="flex items-center gap-1 text-11 text-ink-300" title={t("msg.decodeAuto")}>
          <input type="checkbox" checked={decodeOn} onChange={(e) => setDecodeOn(e.target.checked)} />
          {t("msg.decoded")}
        </label>
        <div className="flex-1" />
        {!isProtected && (
          <button className="btn btn-accent" onClick={onOpenProduce}>
            <Send size={13} /> {t("msg.produce")}
          </button>
        )}
        {!isProtected && (
          <button className="btn btn-danger" onClick={onOpenDelete}>
            <Trash2 size={13} /> {t("msg.deleteRecords")}
          </button>
        )}
        {isProtected && (
          <span className="rounded bg-ink-700 px-2 py-1 text-10 text-ink-300" title={t("topics.protectedHint")}>
            {t("topics.protectedToolbarNote")}
          </span>
        )}
      </div>
    </>
  );
}

export { PAGE_SIZE };
