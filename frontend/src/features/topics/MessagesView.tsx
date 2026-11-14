import { useCallback, useEffect, useRef, useState } from "react";
import { MessagesToolbar } from "./MessagesToolbar.js";
import { GlidingTabs } from "../common/GlidingTabs.js";
import { messagesApi, settingsApi } from "../../shared/api.js";
import { useToast } from "../../state/stores.js";
import { useAppSettings } from "../../state/settings.js";
import { t } from "../../shared/i18n.js";
import { formatBytes, formatNumber, formatTime, toText } from "../../shared/format.js";
import { internalRecordOverride, isProtectedTopic } from "../../shared/kafkaInternal.js";
import { useCopy } from "../../shared/useCopy.js";
import { migrateSelected, rowCells, bestViewFor } from "./bestView.js";
import { useMessageColumnWidths, MessageTableHead } from "./MessageColumns.js";
import { buildBrowseReq, buildFindReq, nextCursor, prevCursor } from "./messagePaging.js";
import type { Message, TopicDetail } from "../../shared/contracts.js";
import { topicsApi } from "../../shared/api.js";
import { TopicConfigs } from "./TopicConfigs.js";
import { SkeletonLines } from "../common/Skeleton.js";
import { Inbox } from "lucide-react";
import { GoToDialog, type GoToTarget } from "./GoToDialog.js";
import { MessageDetail, type ViewMode } from "./MessageDetail.js";
import { RateChart } from "./RateChart.js";
import { useContextMenu } from "../common/ContextMenu.js";
import { MessagesDialogs } from "./MessagesDialogs.js";
import { friendlyError } from "../../shared/api.js";


// MessagesView: the message browser — partition
// selector, page navigation over one partition, detail pane with
// JSON/text/hex rendering, find box, produce and delete-records actions.
// The messages/config switch is controlled by TopicsView so its context
// menu can jump straight to either surface.
export function MessagesView({
  connectionId,
  topic,
  view,
  onViewChange,
}: {
  connectionId: string;
  topic: string;
  view: "messages" | "config" | "visualization";
  onViewChange: (v: "messages" | "config" | "visualization") => void;
  onDeleted?: () => void;
}) {
  const [detail, setDetail] = useState<TopicDetail | null>(null);
  const [partition, setPartition] = useState(0);
  const [messages, setMessages] = useState<Message[]>([]);
  const [cursor, setCursor] = useState<"head" | "tail" | { offset: number }>("tail");
  const [exhausted, setExhausted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Message | null>(null);
  // Detail pane height: user-draggable, persisted per machine.
  const [detailHeight, setDetailHeight] = useState(() => {
    try {
      const v = Number(localStorage.getItem("ke.detailHeight"));
      return v >= 140 ? v : 256;
    } catch {
      return 256;
    }
  });
  const [mode, setMode] = useState<ViewMode>("json");
  // Auto-pick the view that will NOT show garbage for the newly selected
  // record (priority: decode → sniff → hex → text; see bestView.ts). Manual
  // tab switches on the SAME record are never overridden.
  useEffect(() => {
    if (!selected) return;
    setMode(bestViewFor(topic, selected, t));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, topic]);
  const [findPattern, setFindPattern] = useState("");
  const [useRegex, setUseRegex] = useState(false);
  const [scanInfo, setScanInfo] = useState<number | null>(null);
  const [producing, setProducing] = useState(false);
  const [goTo, setGoTo] = useState(false);
  // 解码默认开启：schema 按 id 永久缓存（首屏后零 SR 往返），无 SR 集群
  // 自动降级为标注，无卡顿风险；用户偏好经 localStorage 跨会话保留
  const [decodeOn, setDecodeOn] = useState(() => localStorage.getItem("ke.decode") !== "0");
  // After a find, prev/next are meaningless (the cursor no longer describes
  // the shown window) — suspended until a jump (最新/最早/goto) re-anchors it.
  const [pagingSuspended, setPagingSuspended] = useState(false);
  // Column widths (px) for the message table — session-only by design (a
  // fresh app start returns to the default layout). null = auto.
  // Column sizing hook: session-only widths + drag/reset handlers (see
  // MessageColumns.tsx).
  const { widths: colWidths, startResize, resetCol } = useMessageColumnWidths();
  const updateSettings = useAppSettings((s) => s.update);
  const setPageSize = (n: number) => {
    const cur = useAppSettings.getState().settings;
    if (!cur) return;
    const next = { ...cur, pageSize: n };
    updateSettings(next);
    void settingsApi.save(next).catch((err: unknown) => toast.show(friendlyError(err), "error"));
    setCursor("tail");
    void loadPage("tail", undefined, true);
  };
  const [generating, setGenerating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const toast = useToast();
  const copy = useCopy();
  // Page window size — the 设置页 pageSize value, honored on every load.
  const pageSize = useAppSettings((s) => s.settings?.pageSize ?? 100);
  const { open: openCtx, menu: ctxMenu } = useContextMenu();
  // Monotonic request guard: switching topic/partition while a browse is in
  // flight must not let the stale response overwrite the newer one (the
  // "click A, see B" bug). State updates land only from the latest request.
  const requestSeq = useRef(0);
  // Cross-partition GoTo fires its own request (goto.partition pins it) and
  // THEN commits setPartition; the [partition] effect's duplicate tail
  // reload wins the seq guard and erases a timestamp jump — skip it.
  const pendingGoto = useRef(false);

  useEffect(() => {
    void topicsApi
      .detail(connectionId, topic)
      .then(setDetail)
      .catch((err) => toast.show(friendlyError(err), "error"));
    // Reset browsing state when switching topic.
    setPartition(0);
    setMessages([]);
    setSelected(null);
    setCursor("tail");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, topic]);

  const loadPage = useCallback(
    // silent: suppress the "already on the latest page" toast — automatic
    // loads (topic/partition/pageSize switches, refresh) must never pop it;
    // only an explicit paging action by the user earns that hint.
    async (c: typeof cursor, goto?: GoToTarget, silent?: boolean) => {
      const seq = ++requestSeq.current;
      setLoading(true);
      try {
        const req = buildBrowseReq({ connectionId, topic, partition, pageSize, decodeOn, cursor: c, goto });
        const result = await messagesApi.browse(req as never);
        if (seq !== requestSeq.current) return; // a newer browse superseded us
        setPagingSuspended(false);
        const msgs = result.page.messages ?? [];
        if (msgs.length === 0 && result.exhausted) {
          // past-the-end forward: keep the current rows, never blank out
          setExhausted(true);
          setLoading(false);
          if (!silent) toast.show(t("msg.alreadyLatest"), "info");
          return;
        }
        setMessages(msgs);
        setExhausted(result.exhausted);
        setSelected((cur) => migrateSelected(msgs, cur));
      } catch (err) {
        if (seq === requestSeq.current) toast.show(friendlyError(err), "error");
      } finally {
        if (seq === requestSeq.current) setLoading(false);
      }
    },
    // pageSize/decodeOn in deps: a stale closure kept the old limit alive
    // (paging appeared "dead" — see dev doc round-4).
    [connectionId, topic, partition, pageSize, decodeOn, toast]
  );

  useEffect(() => {
    setSelected(null);
    if (pendingGoto.current) {
      pendingGoto.current = false;
      return; // onJump's request already covers this partition change
    }
    void loadPage(cursor, undefined, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partition, pageSize, decodeOn]);

  const goNext = () => {
    const last = messages[messages.length - 1];
    if (last) {
      const c = nextCursor(last.offset);
      setCursor(c);
      void loadPage(c);
    }
  };
  const goPrev = () => {
    const first = messages[0];
    if (first) {
      const c = prevCursor(first.offset, pageSize);
      setCursor(c);
      void loadPage(c);
    }
  };

  const runFind = async () => {
    if (!findPattern) return;
    const seq = ++requestSeq.current;
    setLoading(true);
    setScanInfo(null);
    try {
      const result = await messagesApi.find(
        buildFindReq({
          connectionId,
          topic,
          partition,
          pageSize,
          pattern: findPattern,
          regex: useRegex,
          maxScan: useAppSettings.getState().settings?.maxScan ?? 100000,
        }) as never,
      );
      if (seq !== requestSeq.current) return;
      setMessages(result.page.messages ?? []);
      setExhausted(result.exhausted);
      setScanInfo(result.scanned);
      setSelected(null);
      setPagingSuspended(true);
    } catch (err) {
      if (seq === requestSeq.current) toast.show(friendlyError(err), "error");
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      {/* slim surface switch: the two views are separate pages, each with
          its own toolbar below — GlidingTabs so the liquid pill runs here
          too (topic detail tabs were plain buttons with no switch motion) */}
      <div className="flex items-center gap-1.5 border-b border-ink-700 bg-ink-900 px-2 py-1.5">
        <GlidingTabs
          small
          tabs={[
            { value: "messages", label: t("topic.messages") },
            { value: "config", label: t("topic.config") },
            { value: "visualization", label: t("topic.viz") },
          ]}
          value={view}
          onChange={(v) => onViewChange(v as typeof view)}
        />
      </div>
      {view === "visualization" && (
        <RateChart connectionId={connectionId} topic={topic} partitions={detail?.partitionList ?? []} />
      )}
      {view === "messages" && (
        <MessagesToolbar
          detail={detail}
          isProtected={isProtectedTopic(topic)}
          partition={partition}
          setPartition={setPartition}
          cursor={cursor}
          setCursor={setCursor}
          loadPage={loadPage}
          exhausted={exhausted}
          loading={loading}
          pagingSuspended={pagingSuspended}
          firstOffset={messages[0]?.offset}
          lastOffset={messages[messages.length - 1]?.offset}
          pageSize={pageSize}
          onPageSizeChange={setPageSize}
          findPattern={findPattern}
          setFindPattern={setFindPattern}
          useRegex={useRegex}
          setUseRegex={setUseRegex}
          scanInfo={scanInfo}
          decodeOn={decodeOn}
          setDecodeOn={(v) => {
            setDecodeOn(v);
            // Turning decode on means the user wants the decoded payload;
            // jump to the decoded tab (raw tabs stay one click away).
            if (v) setMode("decoded");
          }}
          onOpenGoTo={() => setGoTo(true)}
          onOpenGenerate={() => setGenerating(true)}
          onOpenImport={() => setImporting(true)}
          onOpenExport={() => setExporting(true)}
          onOpenProduce={() => setProducing(true)}
          onOpenDelete={() => setDeleting(true)}
          runFind={runFind}
          goPrev={goPrev}
          goNext={goNext}
          // in-place reload of the current window: at the tail cursor this
          // is how newly arrived messages become visible
          refresh={() => void loadPage(cursor, undefined, true)}
        />
      )}
      {view === "config" ? (
        /* Same bounded wrapper as the messages branch: without min-h-0 the
           config table's scroll container overflows the window bottom and
           the last rows can never be scrolled into view. */
        <div className="flex min-h-0 flex-1 flex-col">
        <TopicConfigs
          connectionId={connectionId}
          detail={detail}
          isProtected={isProtectedTopic(topic)}
          onReload={() =>
            void topicsApi
              .detail(connectionId, topic)
              .then(setDetail)
              .catch((err) => toast.show(friendlyError(err), "error"))
          }
        />
        </div>
      ) : (
      /* table + detail split */
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full table-fixed border-collapse text-xs">
            <MessageTableHead widths={colWidths} startResize={startResize} resetCol={resetCol} />
            <tbody
              key={messages.length > 0 ? `${messages[0].partition}-${messages[0].offset}` : "empty"}
              className="anim-fade"
            >
              {loading && messages.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-4">
                    <SkeletonLines rows={5} />
                  </td>
                </tr>
              )}
              {messages.map((m) => {
                // Cell-fallback order (see bestView.rowCells): internal
                // structs → transaction markers → binary sniffer.
                const { keyCell, valueCell } = rowCells(topic, m, t);
                return (
                <tr
                  onContextMenu={(e) =>
                    openCtx(e, [
                      { label: t("ctx.copyOffset"), onSelect: () => copy(String(m.offset)) },
                      { label: t("ctx.copyKey"), onSelect: () => copy(toText(m.key)) },
                      { label: t("ctx.copyValue"), onSelect: () => copy(m.decoded && !m.decoded.error ? m.decoded.text : toText(m.value)) },
                    ])}
                  key={`${m.partition}-${m.offset}`}
                  onClick={() => setSelected(m)}
                  className={`cursor-pointer border-b border-ink-800 ${
                    selected === m ? "bg-accent-muted/60" : "hover:bg-ink-850"
                  }`}
                >
                  <td className="px-2 py-1 font-mono text-ink-300">{m.partition}</td>
                  <td className="px-2 py-1 font-mono text-ink-300">{formatNumber(m.offset)}</td>
                  <td className="px-2 py-1 text-ink-300">{formatTime(m.timestamp)}</td>
                  <td className="max-w-40 truncate px-2 py-1 font-mono text-accent" title={keyCell}>
                    {keyCell || "∅"}
                  </td>
                  <td className="max-w-96 truncate px-2 py-1 font-mono text-ink-200 selectable" title={valueCell}>
                    {valueCell || "∅"}
                  </td>
                  <td className="px-2 py-1 text-ink-300">{formatBytes(m.valueSize)}</td>
                  <td className="px-2 py-1 text-ink-300">{m.headers?.length ?? 0}</td>
                </tr>
                );
              })}
              {!loading && messages.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-6">
                    <div className="flex flex-col items-center gap-2 text-ink-400">
                      <Inbox size={20} />
                      <span className="text-xs">{t("msg.noMessages")}</span>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* detail pane */}
        {selected && (
          <MessageDetail
            message={selected}
            mode={mode}
            setMode={setMode}
            onClose={() => setSelected(null)}
            height={detailHeight}
            onHeightChange={(h) => {
              setDetailHeight(h);
              try {
                localStorage.setItem("ke.detailHeight", String(h));
              } catch {
                /* storage unavailable — height just won't persist */
              }
            }}
            decodedOverride={internalRecordOverride(
              topic,
              selected.key ?? "",
              selected.value ?? "",
              t,
              (n: number) => t("internal.metadataBytes", n),
            )}
          />
        )}
      </div>
      )}

      {ctxMenu}
      {goTo && (
        <GoToDialog
          topic={topic}
          partitions={detail?.partitionList ?? []}
          defaultPartition={partition}
          onJump={(target) => {
            pendingGoto.current = target.partition !== partition;
            setPartition(target.partition);
            setCursor(target.offset !== undefined ? { offset: target.offset } : "tail");
            void loadPage(target.offset !== undefined ? { offset: target.offset } : "tail", target);
          }}
          onClose={() => setGoTo(false)}
        />
      )}
      <MessagesDialogs
        state={{ producing, generating, importing, exporting, deleting }}
        ctx={{ connectionId, topic, detail, partition, cursor, loadPage, setProducing, setGenerating, setImporting, setExporting, setDeleting, setCursor }}
      />
    </div>
  );
}
