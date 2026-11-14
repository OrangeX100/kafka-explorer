import { useCallback, useEffect, useRef, useState } from "react";
import { Events } from "@wailsio/runtime";
import { ksqlDbApi, friendlyError } from "../../shared/api.js";
import { useToast } from "../../state/stores.js";
import { t } from "../../shared/i18n.js";
import { SkeletonLines } from "../common/Skeleton.js";
import { EmptyState } from "../common/EmptyState.js";
import { ErrorHint } from "../common/ErrorHint.js";
import { confirmDialog } from "../common/ConfirmDialog.js";
import { MorphLoader } from "../common/MorphLoader.js";
import { KeyValueTree } from "./KsqlTree.js";
import { Play, Square, Braces } from "lucide-react";
import type { KsqlExecResult } from "../../shared/contracts-admin.js";

const reqID = () => `q-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// A finished (or stopped) query kept in the editor's history.
interface HistoryEntry {
  sql: string;
  rowCount: number;
  elapsedMs: number;
  error?: string;
  at: number;
}

// QueryEditor: SQL text area + run/stop + live results grid + session
// history. Rows arrive over wails events in batches; a push query keeps
// streaming until 停止 cancels it server-side.
export function QueryEditor({ serverId }: { serverId: string }) {
  const [sql, setSql] = useState("SHOW STREAMS;");
  const [running, setRunning] = useState(false);
  const [columns, setColumns] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  const [runError, setRunError] = useState<string | null>(null);
  const [rowCount, setRowCount] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const idRef = useRef<string>("");

  useEffect(() => {
    // batch listener; rows arrive pre-formatted (String(value) per cell)
    const offCols = Events.On(`ksql:columns`, (ev: unknown) => {
      const data = (ev as { data?: { id: string; columns: string[] } })?.data;
      if (!data || data.id !== idRef.current) return;
      setColumns(data.columns);
    });
    const offRows = Events.On(`ksql:rows`, (ev: unknown) => {
      const data = (ev as { data?: { id: string; rows: unknown[][]; final: boolean } })?.data;
      if (!data || data.id !== idRef.current) return;
      setRows((cur) => {
        const next = [...cur];
        for (const r of data.rows) next.push(r.map((v) => (v === null ? "∅" : String(v))));
        return next;
      });
    });
    const offDone = Events.On(`ksql:done`, (ev: unknown) => {
      const data = (ev as { data?: { id: string; error?: string; rowCount: number; elapsedMs: number } })?.data;
      if (!data || data.id !== idRef.current) return;
      setRunning(false);
      setRowCount(data.rowCount);
      setElapsed(data.elapsedMs);
      if (data.error) setRunError(data.error);
      setHistory((h) => [{ sql: runSqlRef.current, rowCount: data.rowCount, elapsedMs: data.elapsedMs, error: data.error, at: Date.now() }, ...h].slice(0, 30));
    });
    return () => {
      offCols();
      offRows();
      offDone();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The SQL AT RUN START: a long push query keeps streaming while the user
  // edits the textarea — the done handler must record the statement that
  // RAN, not whatever the editor holds by then (045 batch-3 round).
  const runSqlRef = useRef(sql);

  const run = async () => {
    if (!sql.trim() || running) return;
    const id = reqID();
    idRef.current = id;
    runSqlRef.current = sql;
    setRunning(true);
    setRunError(null);
    setRowCount(null);
    setElapsed(null);
    // Push queries stream under a fixed column header; pull/SHOW results
    // arrive as plain rows. Either way the grid resets per run.
    setColumns([]);
    setRows([]);
    const t0 = Date.now();
    // SELECT statements run on the streaming endpoint (query-stream);
    // everything else (SHOW/CREATE/DESCRIBE/TERMINATE/SET) is a control
    // statement and must go through POST /ksql — the streaming endpoint
    // rejects control statements outright.
    if (/^\s*select\b/i.test(sql)) {
      try {
        await ksqlDbApi.query(serverId, sql.trim(), id);
      } catch (err) {
        setRunning(false);
        setRunError(friendlyError(err));
      }
      return;
    }
    try {
      const res = await ksqlDbApi.exec(serverId, sql.trim());
      // Render the typed SHOW families as tables; everything else collapses
      // into a 属性/值 grid over the generic entity.
      let count = 0;
      if ((res.streams?.length ?? 0) + (res.tables?.length ?? 0) > 0) {
        const cat = [...(res.streams ?? []), ...(res.tables ?? [])];
        count = cat.length;
        setColumns([t("ksql.colName"), t("ksql.colTopic"), t("ksql.colKeyFormat"), t("ksql.colValueFormat"), t("ksql.colWindow")]);
        setRows(cat.map((r) => [r.name, r.topic, r.keyFormat, r.valueFormat, r.windowType || "—"]));
      } else if (res.queries && res.queries.length > 0) {
        const qs = res.queries;
        count = qs.length;
        setColumns(["ID", t("ksql.colType"), t("connect.taskState"), t("ksql.colSink")]);
        setRows(qs.map((q) => [q.id, q.queryType, q.status, q.sinkName || "—"]));
      } else if (res.genericEntity && Object.keys(res.genericEntity).length > 0) {
        count = Object.keys(res.genericEntity).length;
        setColumns([t("ksql.colProperty"), t("ksql.colValue")]);
        setRows(Object.entries(res.genericEntity).map(([k, v]) => [k, v === null || v === undefined ? "∅" : typeof v === "object" ? JSON.stringify(v) : String(v)]));
      } else {
        // DDL success (CREATE/TERMINATE/...): statement as the record.
        count = 1;
        setColumns([t("ksql.statement")]);
        setRows([[res.statementText || sql.trim()]]);
      }
      setRunning(false);
      setRowCount(count);
      setElapsed(Date.now() - t0);
      setHistory((h) => [{ sql: sql.trim(), rowCount: count, elapsedMs: Date.now() - t0, at: Date.now() }, ...h].slice(0, 30));
    } catch (err) {
      const msg = friendlyError(err);
      setRunning(false);
      setRunError(msg);
      setHistory((h) => [{ sql: sql.trim(), rowCount: 0, elapsedMs: Date.now() - t0, error: msg, at: Date.now() }, ...h].slice(0, 30));
    }
  };


  const stop = () => {
    if (!running) return;
    void ksqlDbApi.cancel(idRef.current);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-none border-b border-ink-700 px-2 py-2">
        <textarea
          className="field h-24 w-full resize-y font-mono text-xs"
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          spellCheck={false}
          placeholder="SELECT * FROM my-stream EMIT CHANGES;"
        />
        <div className="mt-1.5 flex items-center gap-2">
          {!running ? (
            <button className="btn btn-accent" onClick={() => void run()}>
              <Play size={13} /> {t("ksql.run")}
            </button>
          ) : (
            <button className="btn btn-danger" onClick={stop}>
              <Square size={13} /> {t("ksql.stop")}
            </button>
          )}
          {rowCount !== null && (
            <span className="text-11 text-ink-400">{t("ksql.rowsElapsed", rowCount, elapsed ?? 0)}</span>
          )}
          <div className="flex-1" />
          <span className="text-10 text-ink-500">{t("ksql.pushHint")}</span>
        </div>
        {runError && (
          <div className="mt-1.5 rounded border border-danger/40 bg-danger/10 px-2.5 py-1.5 text-11 text-danger selectable">{runError}</div>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {rows.length === 0 && !running ? (
          <EmptyState icon={<Braces size={18} />} title={t("ksql.results")} desc={t("ksql.resultsEmpty")} />
        ) : (
          <table className="w-full table-fixed border-collapse text-xs">
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c} className="table-head px-2 py-1 text-left font-mono">{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-b border-ink-800 hover:bg-ink-850">
                  {r.map((cell, j) => (
                    <td key={j} className="truncate px-2 py-1 font-mono text-ink-200" title={cell}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {history.length > 0 && (
        <div className="max-h-32 flex-none overflow-y-auto border-t border-ink-700 bg-ink-900">
          <div className="px-2 pt-1 text-10 font-semibold uppercase tracking-wide text-ink-400">{t("ksql.history")}</div>
          {history.map((h, i) => (
            <div key={i} className="flex items-center gap-2 border-b border-ink-800 px-2 py-1 text-11 last:border-b-0">
              <span className="min-w-0 flex-1 truncate font-mono text-ink-300" title={h.sql}>{h.sql}</span>
              {h.error ? (
                <span className="text-danger">{t("ksql.historyFailed")}</span>
              ) : (
                <span className="text-ink-400">{t("ksql.rowsElapsed", h.rowCount, h.elapsedMs)}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// CatalogList: SHOW STREAMS / SHOW TABLES rows with a describe detail
// toggle (DESCRIBE renders as key/value; 8.0 dropped EXTENDED).
export function CatalogList({ serverId, kind }: { serverId: string; kind: "streams" | "tables" }) {
  const [items, setItems] = useState<KsqlExecResult | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [detailText, setDetailText] = useState<KsqlExecResult | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const toast = { show: useToast((s) => s.show) };

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setItems(await ksqlDbApi.exec(serverId, kind === "streams" ? "SHOW STREAMS" : "SHOW TABLES"));
    } catch (err) {
      setLoadError(err);
    }
  }, [serverId, kind]);

  useEffect(() => {
    void load();
  }, [load]);

  const showDetail = async (name: string) => {
    setDetail(name);
    setDetailLoading(true);
    setDetailText(null);
    try {
      setDetailText(await ksqlDbApi.exec(serverId, `DESCRIBE ${name}`));
    } catch (err) {
      toast.show(friendlyError(err), "error");
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  };

  const rows = kind === "streams" ? (items?.streams ?? []) : (items?.tables ?? []);
  // skeleton-morph: skeleton and content live in ONE grid cell — the fetch
  // resolving flips one data-state and CSS cross-morphs (loader morphs to
  // its result glyph and fades, content resolves from a 4px blur) instead
  // of unmount/flash.
  const state = loadError !== null ? "error" : items === null ? "loading" : "content";
  return (
    <div className="min-h-0 flex-1 overflow-auto p-2">
      <div className="ksql-loader" data-state={state}>
        <div className="ksql-skeleton">
          <MorphLoader status={state === "loading" ? "loading" : state === "error" ? "error" : "done"} />
        </div>
        <div className="ksql-content">
          {rows.length === 0 && (
            <EmptyState icon={<Braces size={18} />} title={t(kind === "streams" ? "ksql.tabStreams" : "ksql.tabTables")} desc={t("ksql.catalogEmpty")} />
          )}
          {rows.length > 0 && (
            <table className="w-full table-fixed border-collapse text-xs">
              <thead>
                <tr>
                  <th className="table-head w-56 px-2 py-1 text-left">{t("ksql.colName")}</th>
                  <th className="table-head w-48 px-2 py-1 text-left">{t("ksql.colTopic")}</th>
                  <th className="table-head w-24 px-2 py-1 text-left">{t("ksql.colKeyFormat")}</th>
                  <th className="table-head w-24 px-2 py-1 text-left">{t("ksql.colValueFormat")}</th>
                  <th className="table-head px-2 py-1 text-left">{t("ksql.colWindow")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.name}
                    onClick={() => void showDetail(r.name)}
                    className={`cursor-pointer border-b border-ink-800 ${detail === r.name ? "bg-accent-muted/60" : "hover:bg-ink-850"}`}
                  >
                    <td className="truncate px-2 py-1 font-mono text-ink-100" title={r.name}>{r.name}</td>
                    <td className="truncate px-2 py-1 font-mono text-ink-300" title={r.topic}>{r.topic}</td>
                    <td className="px-2 py-1 text-ink-300">{r.keyFormat}</td>
                    <td className="px-2 py-1 text-ink-300">{r.valueFormat}</td>
                    <td className="px-2 py-1 text-ink-400">{r.windowType || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
      {loadError !== null && (
        <div className="mt-2">
          <ErrorHint error={loadError} onRetry={() => void load()} onDismiss={() => setLoadError(null)} />
        </div>
      )}
      {(detailLoading || detailText !== null) && (
        <div className="mt-2 rounded border border-ink-700 bg-ink-900">
          <div className="flex items-center border-b border-ink-700 px-2 py-1 text-11 font-semibold text-ink-200">
            {t("ksql.describe", detail ?? "")}
            <div className="flex-1" />
            <button className="btn !px-1.5 !py-0.5" onClick={() => { setDetail(null); setDetailText(null); }}>✕</button>
          </div>
          <div className="max-h-72 overflow-auto px-2 py-1.5">
            {detailLoading && <SkeletonLines rows={3} />}
            {detailText?.genericEntity && <KeyValueTree entity={detailText.genericEntity} />}
          </div>
        </div>
      )}
    </div>
  );
}

// QueriesList: persistent queries with terminate.
export function QueriesList({ serverId }: { serverId: string }) {
  const [items, setItems] = useState<KsqlExecResult | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const toast = { show: useToast((s) => s.show) };

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setItems(await ksqlDbApi.exec(serverId, "SHOW QUERIES"));
    } catch (err) {
      setLoadError(err);
    }
  }, [serverId]);

  useEffect(() => {
    void load();
  }, [load]);

  const terminate = async (q: { id: string }) => {
    if (!(await confirmDialog({ message: t("ksql.terminateConfirm", q.id), danger: true }))) return;
    try {
      await ksqlDbApi.exec(serverId, `TERMINATE ${q.id}`);
      toast.show(t("ksql.terminatedOk", q.id), "ok");
      await load();
    } catch (err) {
      toast.show(friendlyError(err), "error");
    }
  };

  const stateColor = (s: string) =>
    s === "RUNNING" ? "text-ok" : s.includes("ERROR") || s === "FAILED" ? "text-danger" : "text-warn";

  const qState = loadError !== null ? "error" : items === null ? "loading" : "content";
  return (
    <div className="min-h-0 flex-1 overflow-auto p-2">
      <div className="ksql-loader" data-state={qState}>
        <div className="ksql-skeleton">
          <MorphLoader status={qState === "loading" ? "loading" : qState === "error" ? "error" : "done"} />
        </div>
        <div className="ksql-content">
          {(items?.queries ?? []).length === 0 && (
            <EmptyState icon={<Braces size={18} />} title={t("ksql.tabQueries")} desc={t("ksql.queriesEmpty")} />
          )}
          {(items?.queries ?? []).map((q) => (
            <div key={q.id} data-testid="ksql-query-row" className="flex items-center gap-3 border-b border-ink-800 px-2 py-2 text-xs">
              <span className="w-64 truncate font-mono text-ink-100" title={q.id}>{q.id}</span>
              <span className="rounded bg-ink-800 px-1.5 py-0.5 text-10 text-ink-300">{q.queryType}</span>
              <span className={`font-medium ${stateColor(q.status)}`}>{q.status}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-10 text-ink-400" title={q.sql}>{q.sql || q.sinkName}</span>
              <button className="btn btn-danger !px-1.5 !py-0.5" onClick={() => void terminate(q)}>{t("ksql.terminate")}</button>
            </div>
          ))}
        </div>
      </div>
      {loadError !== null && (
        <div className="mt-2">
          <ErrorHint error={loadError} onRetry={() => void load()} onDismiss={() => setLoadError(null)} />
        </div>
      )}
    </div>
  );
}
