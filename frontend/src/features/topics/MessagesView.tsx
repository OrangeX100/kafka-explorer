import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
    // 跳转在途时让路直发：store 已更新，[pageSize] effect 重燃后会被
    // pendingGoto 抑制进 suppressedRefire，跳转 finally 用同步后的锚点
    // 窗口 + 新页大小补燃——新值不丢、跳转窗口不被 tail 冲掉
    // （2026-11-22 评审 F1；旧守卫连 updateSettings 一起 return，用户
    // 选的新页大小曾被静默丢弃，注释宣称的重载并不存在）
    if (pendingGoto.current) return;
    setCursor("tail");
    void loadPage("tail", undefined, true);
  };
  const [generating, setGenerating] = useState(false);
  // 压缩主题（cleanup.policy=compact）：旧值被 broker 按 key 物理删除——
  // 水位（分区选择器的 N）≠ 实际存活记录数，尾页行数少于页大小属正常
  // 语义（2026-11-21 用户报告"72 条只显示 9 条"，broker 实证 _schemas
  // compact、水位 72、存活 23）。显示说明条消除"丢消息"误解。
  const isCompacted = detail?.config.some(
    (c) => c.name === "cleanup.policy" && (c.value ?? "").includes("compact"),
  ) ?? false;
  // 尾页不可见记录检测（2026-11-21 用户报告 ksql 命令主题"2 条只显示 1 条"，
  // dump-log 实证 offset 1 = endTxnMarker COMMIT——事务控制记录对所有消费
  // 者不可见）。exhausted 尾页内 存活行数 < (logEnd − 页内最小 offset) 即
  // 区间存在不可见记录；delete 策略主题该区间必连续（LogStart 之外的旧段
  // 已被整段滚出、不在水位口径内），不会误报。
  //
  // 两道防假阳性门（2026-11-22 评审）：
  // - pagingSuspended：find 结果页也置 exhausted 但只含匹配行，"区间连续"
  //   前提完全不成立（搜命中最旧 2 条 → 横幅敢报"尾段 9993 条不可见"）；
  // - 行属分区一致性：跨分区跳转在途/目标越界的早退路径会留下旧分区行配
  //   新分区的 logEnd，算术结果无意义且可能持久显示。
  const viewPartition = messages.length > 0 ? messages[0].partition : null;
  const rowsBelongToPartition = viewPartition === partition;
  const tailGap = useMemo(() => {
    if (!exhausted || pagingSuspended || !rowsBelongToPartition || messages.length === 0) return 0;
    const part = detail?.partitionList.find((p) => p.id === partition);
    if (!part) return 0;
    const minOff = Math.min(...messages.map((m) => m.offset));
    const missing = part.logEnd - minOff - messages.length;
    return missing > 0 ? missing : 0;
  }, [exhausted, pagingSuspended, rowsBelongToPartition, messages, detail, partition]);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const toast = useToast();
  const copy = useCopy();
  // Page window size — the 设置页 pageSize value, honored on every load.
  const pageSize = useAppSettings((s) => s.settings?.pageSize ?? 50); // 50 = 后端默认页大小，启动窗口兜底不再放大首屏（0.4.21 P3）
  const { open: openCtx, menu: ctxMenu } = useContextMenu();
  // Monotonic request guard: switching topic/partition while a browse is in
  // flight must not let the stale response overwrite the newer one (the
  // "click A, see B" bug). State updates land only from the latest request.
  const requestSeq = useRef(0);
  // True while a jump request is in flight (cleared in loadPage finally):
  // every [partition/pageSize/decodeOn] effect re-fire during the flight
  // skips its duplicate reload (single-path rework — the request itself is
  // issued BY that effect, see pendingGotoTarget below).
  const pendingGoto = useRef(false);
  // The jump TARGET rides the effect as the single request path: onJump
  // only parks the target + commits partition/cursor state, and the
  // [partition] effect below fires the browse with goto pinned. The old
  // double path (onJump firing its own request while the effect merely
  // skips) depended on pendingGoto outliving A until the effect ran — on a
  // slow render pipeline the effect fires AFTER A's finally cleared the
  // flag, its tail reload wins the seq guard, and the table lands empty
  // forever (2026-11-21 CI: cross-partition jump → empty, 3/3 attempts).
  const pendingGotoTarget = useRef<GoToTarget | null>(null);
  // 跳转 watchdog 定时器：跨分区跳转在途 45s 无响应即补发目标 tail
  // （见 onJump 跨分区分支——"empty 120s" 的终极兜底，0.4.22）。
  // gotoFlight 是跳转代次：定时器回调与代次绑定——A/B 重叠跳转时 A 的
  // finally 不得解除 B 的 watchdog（0.4.21 二轮评审 P1：无归属绑定曾让
  // 二次跳转失去 45s 兜底并提前解除 pendingGoto 保护）
  const gotoWatchdog = useRef<number | null>(null);
  const gotoFlight = useRef(0);
  // Set when an effect re-fire was suppressed by an in-flight jump (user
  // changed pageSize/decodeOn mid-jump). Bumped via refireTick after the
  // flight so the effect re-runs with a FRESH closure — a direct loadPage
  // call from the old finally would reuse the stale closure (045 round-4
  // family). Jumps without concurrent changes never bump it.
  const suppressedRefire = useRef(false);
  const [refireTick, setRefireTick] = useState(0);

  // 组件卸载：解除 watchdog（僵尸定时器 45s 后会以死闭包发起一次真实
  // browse——后端与 IPC 都白白消耗，0.4.21 二轮评审 P4）
  useEffect(
    () => () => {
      if (gotoWatchdog.current !== null) {
        clearTimeout(gotoWatchdog.current);
        gotoWatchdog.current = null;
      }
    },
    [],
  );

  useEffect(() => {
    // 切主题/连接：解除可能残留的跳转 watchdog（否则 45s 内切主题后，
    // watchdog 补发会以旧主题的闭包发起 browse——旧主题行注入新主题视图）
    if (gotoWatchdog.current !== null) {
      clearTimeout(gotoWatchdog.current);
      gotoWatchdog.current = null;
    }
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
      // loading 所有权：被更新的请求取代（seq 失配）时不得吹灭别人的骨架
      // ——旧响应迟到曾把跳转在途的 loading 关掉，清表后直接渲染假"暂无
      // 消息"空态（0.4.21 评审 P2-3；runFind 同款条件释放是既有范式）。
      // catch 的 tail-retry 会 bump seq，owner 随之转移。
      let owner = seq;
      setLoading(true);
      try {
        const req = buildBrowseReq({ connectionId, topic, partition, pageSize, decodeOn, cursor: c, goto });
        const result = await messagesApi.browse(req as never);
        if (seq !== requestSeq.current) return; // a newer browse superseded us
        setPagingSuspended(false);
        const msgs = result.page.messages ?? [];
        // 统一升序：backward/tail 页后端按 offset 降序送达，直接渲染会让
        // goPrev/goNext 的 messages[0]/messages[last] 语义翻转（首击只移
        // 1 条——045 round-6 存量）。sort 后 badges/paging/title 全一致。
        msgs.sort((a, b) => a.offset - b.offset);
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
        if (goto && goto.offset === undefined && msgs.length > 0) {
          // Timestamp jump: onJump parked the cursor at "tail", which the
          // position badge renders as 最新一页 — a lie once the rows land on
          // the timestamp window (045 CDP round). Sync the cursor to the
          // window's LOWEST offset so refresh/paging resolve to exactly this
          // window. msgs is ALREADY ascending (sorted at :192) — the old
          // msgs[last] grab (with a stale DESCENDING comment) anchored the
          // TOP of the window, so a refresh started from the NEXT window
          // instead of reloading this one (0.4.21 external review P2).
          setCursor({ offset: msgs[0].offset });
        }
      } catch (err) {
        if (seq === requestSeq.current) {
          toast.show(friendlyError(err), "error");
          // A failed jump leaves the table on the OLD partition's rows while
          // the selector already shows the new partition. Reload the new
          // partition's tail explicitly — the retry rides the request's own
          // goto pin (goto.partition), so it lands on the RIGHT partition
          // even though this closure may be from any render.
          if (goto) {
            requestSeq.current++; // invalidate the failed request
            const req = buildBrowseReq({
              connectionId, topic, partition: goto.partition, pageSize, decodeOn, cursor: "tail",
            });
            const retrySeq = requestSeq.current;
            owner = retrySeq; // loading 所有权随 retry 转移（见上方 owner 声明）
            try {
              const result = await messagesApi.browse(req as never);
              if (retrySeq !== requestSeq.current) return;
              setPagingSuspended(false);
              const msgs = result.page.messages ?? [];
              // 与主路径同构：backward/tail 重试按 offset 降序送达——不排序
              // 则表格降序渲染、goPrev/goNext 语义翻转、徽标倒挂（0.4.21
              // 评审 P2-1：此路径缺主路径 :192 的 sort）。升序后 msgs[last]
              // 即最新行，锚点语义与主路径一致。
              msgs.sort((a, b) => a.offset - b.offset);
              setMessages(msgs);
              setExhausted(result.exhausted);
              setSelected(null);
              // the retry lands on goto.partition's TAIL — anchor the cursor
              // at the window's LOWEST offset or refresh would start from the
              // NEXT window (升序后 msgs[0] 即窗口起点；旧值 msgs[last] 是
              // sort 引入前的化石语义——0.4.21 二轮评审 P2-1)
              if (msgs.length > 0) setCursor({ offset: msgs[0].offset });
            } catch { /* the toast above already told the user */ }
          }
        }
      } finally {
        if (goto) {
          // flight 归属校验：仅最新代次的 flight 才解除 pendingGoto 保护
          // 与 watchdog——被取代跳转的晚到响应曾无条件清掉新一轮跳转的
          // 保护（0.4.21 二轮深审 P2-3 残洞：B 的 watchdog 守卫半边被瓦
          // 解）。watchdog 定时器由归属方清：新 onJump 清旧起新、回调
          // flight 自检、finally 归属清——三路一致。
          if (goto.flight === gotoFlight.current) {
            if (gotoWatchdog.current !== null) {
              clearTimeout(gotoWatchdog.current);
              gotoWatchdog.current = null;
            }
            pendingGoto.current = false; // flight over: toggles work again
          }
          // A suppressed pageSize/decodeOn re-fire gets its fresh-closure
          // reload now; a jump without concurrent changes stays single-shot.
          if (suppressedRefire.current) {
            suppressedRefire.current = false;
            setRefireTick((t) => t + 1);
          }
        }
        // 所有权检查释放：owner === requestSeq 时才吹灯。旧的无条件释放会
        // 在"被取代的旧响应迟到"时关掉跳转在途的骨架（P2-3）；failed-jump
        // 的 retry 通过 owner 转移保持释放（045 round-4 的卡 loading 不复现
        // ——retry 完成时 owner 已是 retrySeq）。
        if (owner === requestSeq.current) setLoading(false);
      }
    },
    // pageSize/decodeOn in deps: a stale closure kept the old limit alive
    // (paging appeared "dead" — see dev doc round-4).
    [connectionId, topic, partition, pageSize, decodeOn, toast]
  );

  useEffect(() => {
    setSelected(null);
    // A parked jump target: this effect IS the request (single path — see
    // pendingGotoTarget). Clear it here so later pageSize/decodeOn refires
    // fall through to the plain tail reload.
    const gt = pendingGotoTarget.current;
    if (gt) {
      pendingGotoTarget.current = null;
      void loadPage(gt.offset !== undefined ? { offset: gt.offset } : "tail", gt, true);
      return;
    }
    // pendingGoto clears when the jump REQUEST completes (loadPage finally),
    // so every effect re-fire DURING the flight — partition, pageSize or
    // decodeOn — skips its duplicate tail reload, not just the partition one.
    if (pendingGoto.current) {
      suppressedRefire.current = true; // the finally re-fires us via the tick
      return;
    }
    void loadPage(cursor, undefined, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partition, pageSize, decodeOn, refireTick]);

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
        <>
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
          // 扫描数只描述 find 结果页：重新锚定（跳转/翻页）后 pagingSuspended
          // 复位，陈旧的 "已扫描 N" 标注随表格内容一起退场（0.4.20 P3）
          scanInfo={pagingSuspended ? scanInfo : null}
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
        {isCompacted && exhausted && !pagingSuspended && rowsBelongToPartition && messages.length > 0 && messages.length < pageSize && (
          <div className="flex-none px-3 py-1.5 text-11 text-ink-300 border-b border-ink-700 bg-ink-900" data-testid="compaction-note">
            {t("msg.compactedNote", detail?.partitionList.find((p) => p.id === partition)?.messageCount ?? "—")}
          </div>
        )}
        {!isCompacted && exhausted && tailGap > 0 && (
          <div className="flex-none px-3 py-1.5 text-11 text-ink-300 border-b border-ink-700 bg-ink-900" data-testid="gap-note">
            {t("msg.gapNote", tailGap)}
          </div>
        )}
        </>
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
          {/* detail 就绪信号：watermark 探针用它区分“config 未加载导致的
              暂无横幅”（继续等）与“就绪后仍无横幅”（真缺陷信号）——
              isCompacted/横幅判定全部依赖 detail.config（0.4.20 P3） */}
          <table
            className="w-full table-fixed border-collapse text-xs"
            data-detail-ready={detail ? "1" : "0"}
          >
            <MessageTableHead widths={colWidths} startResize={startResize} resetCol={resetCol} />
            {/* NO keyed tbody + anim-fade here: the per-window key remounted
                the whole tbody on every page flip, and for one frame the old
                and new tbody coexisted in the DOM — probe hit-test counts
                read 36 rows for a 25-row window ("行叠加"). Rows render
                without a fade (the tbody-level animation WAS the artifact);
                per-row keys keep reconciliation correct. (2026-11-21) */}
            <tbody>
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
                  <td className="max-w-40 truncate px-2 py-1 font-mono text-accent" title={keyCell.length <= 512 ? keyCell : undefined}>
                    {keyCell || "∅"}
                  </td>
                  <td className="max-w-96 truncate px-2 py-1 font-mono text-ink-200 selectable" title={valueCell.length <= 512 ? valueCell : undefined}>
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
              // 内存态实时更新；持久化只在拖动结束时写一次（pointermove
              // 60-120Hz 同步写 localStorage 曾是拖拽卡顿的一部分——045
              // round-5 UI 规模镜头）。
              setDetailHeight(h);
            }}
            onHeightCommit={(h) => {
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
            // In-flight until the jump request completes (loadPage finally):
            // every effect re-fire in that window — partition, pageSize,
            // decodeOn — would send a duplicate tail reload that wins the
            // seq guard and erases the target window.
            pendingGoto.current = true;
            gotoFlight.current++; // 新代次：watchdog 回调以此归属归属校验
            if (target.partition === partition) {
              // Same partition: setPartition is a no-op, the effect below
              // never fires — fire the request here as before.
              void loadPage(target.offset !== undefined ? { offset: target.offset } : "tail", target);
            } else {
              // Cross-partition: park the target and let the [partition]
              // effect fire the ONE request (single-path rework — the old
              // onJump-issued request raced its own finally on slow render
              // pipelines and left the table empty, 2026-11-21 CI 3/3).
              // 0.4.20 flaky 根治：先物理清掉旧分区行再落请求——CI 慢管线
              // 曾让 p0 旧行稳定停留 120s+（跳转响应落地被什么路径压掉都
              // 好，表格内容先归零，骨架接管直到目标分区行落地）。旧行属
              // 旧分区，跳转后保留它们本身就是错误展示。
              pendingGotoTarget.current = target;
              setSelected(null);
              setExhausted(false);
              setMessages([]);
              setLoading(true);
              // watchdog（0.4.22）：后端 BrowsePage 15s 总预算内必有响应，
              // 45s 仍 pending = 请求已死（wails IPC/未知路径）。失效在途
              // seq 并补发目标分区 tail——"empty 120s" 的终极兜底（CI 实测
              // 两次 attempt 皆 120s empty 而 retry 27s 全程过）。正常跳转
              // 秒级落地，watchdog 不触发；补发与 catch 的 tail-retry 同形态。
              const myFlight = gotoFlight.current;
              if (gotoWatchdog.current !== null) clearTimeout(gotoWatchdog.current);
              gotoWatchdog.current = window.setTimeout(() => {
                gotoWatchdog.current = null;
                // flight 归属校验：已被更新的跳转（新代次）接管则退让；
                // 跳转已完成（pendingGoto 复位）同样退让
                if (gotoFlight.current !== myFlight || !pendingGoto.current) return;
                console.log("[goto-watchdog] 45s no response — reissuing target tail");
                requestSeq.current++; // 失效在途请求
                void loadPage("tail", { partition: target.partition }, true);
              }, 45_000);
              setPartition(target.partition);
            }
            setCursor(target.offset !== undefined ? { offset: target.offset } : "tail");
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
