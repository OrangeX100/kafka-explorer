import { t } from "../../shared/i18n.js";
import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

// JsonView renders a parsed JSON payload as a collapsible tree — root and
// every nested object/array can fold. Falls back to the raw text when the
// payload is not valid JSON.
export function JsonView({ text }: { text: string }) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return <>{text}</>;
  }
  return (
    <div className="font-mono text-11 leading-relaxed selectable">
      <Node label="" value={parsed} depth={0} />
    </div>
  );
}

function Primitive({ v }: { v: unknown }) {
  if (typeof v === "string") return <span className="text-ok">"{v}"</span>;
  if (v === null) return <span className="text-ink-400">null</span>;
  if (typeof v === "number" || typeof v === "boolean") return <span className="text-warn">{String(v)}</span>;
  return <span>{String(v)}</span>;
}

function Node({ label, value, depth }: { label: string; value: unknown; depth: number }) {
  // Hooks BEFORE the isContainer early return: the root Node instance is
  // reused across selected messages, so a scalar body would change the hook
  // count 1→0 → React #300 white screen.
  const [open, setOpen] = useState(depth < 2);
  const isContainer = value !== null && typeof value === "object";
  const keyEl =
    label === "" ? null : (
      <>
        <span className="text-accent">{/^[A-Za-z_$][\w$]*$/.test(label) ? label : JSON.stringify(label)}</span>
        <span className="text-ink-400">: </span>
      </>
    );

  if (!isContainer) {
    return (
      <div className="whitespace-pre-wrap break-all">
        {keyEl}
        <Primitive v={value} />
      </div>
    );
  }

  const entries: [string, unknown][] = Array.isArray(value)
    ? (value as unknown[]).map((v, i) => [String(i), v])
    : Object.entries(value as Record<string, unknown>);
  const isArray = Array.isArray(value);
  const openBrace = isArray ? "[" : "{";
  const closeBrace = isArray ? "]" : "}";

  // Empty containers render inline — nothing to fold.
  if (entries.length === 0) {
    return (
      <div>
        {keyEl}
        {openBrace}
        {closeBrace}
      </div>
    );
  }

  return (
    <div>
      <button
        className="flex items-start gap-0.5 rounded text-left hover:text-accent"
        onClick={() => setOpen(!open)}
        title={open ? t("json.collapse") : t("json.expand")}
      >
        {open ? <ChevronDown size={12} className="mt-0.5 shrink-0" /> : <ChevronRight size={12} className="mt-0.5 shrink-0" />}
        {keyEl}
        {open ? (
          openBrace
        ) : (
          <span className="text-ink-400">
            {openBrace} … {entries.length} {t(isArray ? "json.items" : "json.keys")} {closeBrace}
          </span>
        )}
      </button>
      {open && (
        <>
          <div className="pl-4">
            {entries.map(([k, v]) => (
              <Node key={k} label={isArray ? "" : k} value={v} depth={depth + 1} />
            ))}
          </div>
          <div>{closeBrace}{depth > 0 ? "," : ""}</div>
        </>
      )}
    </div>
  );
}
