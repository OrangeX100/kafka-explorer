import { useMemo, useState } from "react";
import { GitCompare } from "lucide-react";
import { Select } from "../common/controls.js";
import { SkeletonLines } from "../common/Skeleton.js";
import { t } from "../../shared/i18n.js";
import type { SchemaVersion } from "../../shared/contracts-admin.js";
import { diffLines, diffStats } from "../../shared/diff.js";

// Two-version diff : pretty-printed schemas on both
// sides, LCS line diff with add/del gutters and per-side line numbers.
export function DiffTab({
  versions,
  latest,
  subjectName,
}: {
  versions: SchemaVersion[] | null;
  latest: number;
  subjectName: string;
}) {
  const opts = (versions ?? []).map((v) => ({ value: String(v.version), label: `${t("reg.colVersion")} ${v.version}` }));
  const [a, setA] = useState<string>("");
  const [b, setB] = useState<string>(String(latest));
  const va = versions?.find((v) => v.version === Number(a)) ?? versions?.[0];
  const vb = versions?.find((v) => v.version === Number(b)) ?? versions?.find((v) => v.version === latest);
  const rows = useMemo(() => (va && vb ? diffLines(prettySchema(va.schema), prettySchema(vb.schema)) : []), [va, vb]);
  const stats = diffStats(rows);
  if (!versions)
    return (
      <div className="p-3">
        <SkeletonLines rows={6} />
      </div>
    );
  if (versions.length < 2) {
    return <div className="p-6 text-center text-xs text-ink-400">{t("reg.diffNeedTwo")}</div>;
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-ink-800 px-3 py-1.5 text-11 text-ink-300">
        <GitCompare size={13} className="text-ink-400" />
        <span className="w-36">
          <Select value={a || String(versions[0]?.version ?? "")} options={opts} onChange={setA} />
        </span>
        <span className="text-ink-400">→</span>
        <span className="w-36">
          <Select value={b} options={opts} onChange={setB} />
        </span>
        <span className="text-10 text-ink-400">
          +{stats.added} / −{stats.removed}
        </span>
        <div className="flex-1" />
        <span className="truncate font-mono text-10" title={subjectName}>
          {subjectName}
        </span>
      </div>
      <div className="m-3 min-h-0 flex-1 overflow-auto rounded border border-ink-700 bg-ink-900 font-mono text-11 leading-relaxed">
        {rows.map((r, i) => (
          <div
            key={i}
            className={`flex gap-2 px-3 py-0.5 selectable ${
              r.kind === "add" ? "bg-ok/10 text-ok" : r.kind === "del" ? "bg-danger/10 text-danger" : "text-ink-200"
            }`}
          >
            <span className="w-8 flex-none select-none text-right text-10 text-ink-500">{r.aLine ?? ""}</span>
            <span className="w-8 flex-none select-none text-right text-10 text-ink-500">{r.bLine ?? ""}</span>
            <span className="w-3 flex-none select-none">{r.kind === "add" ? "+" : r.kind === "del" ? "−" : " "}</span>
            <span className="whitespace-pre-wrap break-all">{r.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function prettySchema(schema: string): string {
  try {
    return JSON.stringify(JSON.parse(schema), null, 2);
  } catch {
    return schema;
  }
}
