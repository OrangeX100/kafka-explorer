import { useState } from "react";
import { GitCompare } from "lucide-react";
import { adminApi } from "../../shared/api.js";
import { useConnections, useToast } from "../../state/stores.js";
import { t } from "../../shared/i18n.js";
import { useContextMenu } from "../common/ContextMenu.js";
import { useCopy } from "../../shared/useCopy.js";
import { Copy } from "lucide-react";
import { EmptyState } from "../common/EmptyState.js";
import type { ClusterDiff } from "../../shared/contracts-admin.js";
import { friendlyError } from "../../shared/api.js";
import { Select } from "../common/controls.js";

// CompareView: pick two saved connections and diff their topic sets.
export function CompareView() {
  const { open: openCtx, menu: ctxMenu } = useContextMenu();
  const copy = useCopy();
  const list = useConnections((s) => s.list);
  const [connA, setConnA] = useState("");
  const [connB, setConnB] = useState("");
  const [diff, setDiff] = useState<ClusterDiff | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const run = async () => {
    if (!connA || !connB || connA === connB) return;
    setBusy(true);
    try {
      setDiff(await adminApi.clusterDiff(connA, connB));
    } catch (err) {
      toast.show(friendlyError(err), "error");
    } finally {
      setBusy(false);
    }
  };

  const nameOf = (id: string) => list.find((c) => c.id === id)?.name ?? id;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-ink-700 bg-ink-900 px-3 py-2">
                <Select
          className="!w-52"
          value={connA}
          options={[{ value: "", label: t("compare.pickA") }, ...list.map((c) => ({ value: c.id, label: c.name }))]}
          onChange={(v) => setConnA(v)}
        />
        <GitCompare size={14} className="text-ink-400" />
                <Select
          className="!w-52"
          value={connB}
          options={[{ value: "", label: t("compare.pickB") }, ...list.map((c) => ({ value: c.id, label: c.name }))]}
          onChange={(v) => setConnB(v)}
        />
        <button className="btn btn-accent" disabled={busy || !connA || !connB || connA === connB} onClick={() => void run()}>
          {t("compare.run")}
        </button>
        {diff && (
          <span className="text-11 text-ink-400">
            {nameOf(connA)} ↔ {nameOf(connB)}
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {diff === null ? (
          <EmptyState icon={<GitCompare size={20} />} title={t("ws.compare")} desc={t("compare.run")} />
        ) : (
          <div className="space-y-4">
            <DiffSection title={t("compare.onlyInA")} topics={diff.topicsOnlyInA} tone="warn" />
            <DiffSection title={t("compare.onlyInB")} topics={diff.topicsOnlyInB} tone="danger" />
            <div>
              <div className="mb-1.5 text-xs font-medium text-ink-300">
                {t("compare.both")} ({diff.both.length})
              </div>
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr>
                    <th className="table-head px-2 py-1.5">{t("compare.colTopic")}</th>
                    <th className="table-head px-2 py-1.5">{t("compare.colParts")}</th>
                    <th className="table-head px-2 py-1.5">{t("compare.match")}</th>
                  </tr>
                </thead>
                <tbody>
                  {diff.both.map((p) => (
                    <tr
                      key={p.topic}
                      className="border-b border-ink-800 hover:bg-ink-850"
                      onContextMenu={(e) =>
                        openCtx(e, [
                          { label: t("ctx.copyName"), icon: <Copy size={13} />, onSelect: () => copy(p.topic) },
                        ])
                      }
                    >
                      <td className="px-2 py-1 font-mono">{p.topic}</td>
                      <td className="px-2 py-1 font-mono text-ink-300">
                        {p.partitionsA}/{p.partitionsB}
                      </td>
                      <td className={`px-2 py-1 ${p.partitionMatch ? "text-ok" : "text-warn"}`}>
                        {p.partitionMatch ? t("compare.match") : t("compare.mismatch")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {ctxMenu}
          </div>
        )}
      </div>
    </div>
  );
}

function DiffSection({ title, topics, tone }: { title: string; topics: string[]; tone: "warn" | "danger" }) {
  if (topics.length === 0) return null;
  return (
    <div>
      <div className={`mb-1.5 text-xs font-medium ${tone === "warn" ? "text-warn" : "text-danger"}`}>
        {title} ({topics.length})
      </div>
      <div className="flex flex-wrap gap-1.5">
        {topics.map((tp) => (
          <span key={tp} className="rounded bg-ink-800 px-1.5 py-0.5 font-mono text-11 text-ink-200">
            {tp}
          </span>
        ))}
      </div>
    </div>
  );
}
