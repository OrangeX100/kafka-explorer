// KeyValueTree renders a generic ksqlDB entity (DESCRIBE) as an
// indenting key/value tree — arrays as nested rows.
export function KeyValueTree({ entity, depth = 0 }: { entity: Record<string, unknown>; depth?: number }) {
  return (
    <div className={depth === 0 ? "space-y-0.5" : ""}>
      {Object.entries(entity).map(([k, v]) => (
        <div key={k} style={{ paddingLeft: depth * 12 }}>
          <span className="font-mono text-10 text-ink-400">{k}: </span>
          {v === null || v === undefined ? (
            <span className="font-mono text-10 text-ink-500">∅</span>
          ) : typeof v === "object" ? (
            Array.isArray(v) && v.every((x) => x === null || typeof x !== "object") ? (
              <span className="font-mono text-10 text-ink-200">[{v.map(String).join(", ")}]</span>
            ) : (
              <KeyValueTree entity={v as Record<string, unknown>} depth={depth + 1} />
            )
          ) : (
            <span className="selectable font-mono text-10 text-ink-200">{String(v)}</span>
          )}
        </div>
      ))}
    </div>
  );
}
