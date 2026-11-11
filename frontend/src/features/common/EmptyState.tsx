import type { ReactNode } from "react";

// Adapted from ui-motion activity/empty-state: icon tile scales in on mount
// (480ms snappy), quiet centered layout for pane-level empties. No card
// border — inside this app the empty state sits in an existing panel.
interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  desc?: ReactNode;
  // Numbered how-to steps rendered under desc (enable-auth guides etc.).
  steps?: string[];
  danger?: boolean;
  action?: { label: string; onClick: () => void };
}

export function EmptyState({ icon, title, desc, steps, danger, action }: EmptyStateProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 py-10 text-center" role="status">
      <div
        className={`anim-icon mb-3 flex h-12 w-12 items-center justify-center rounded-lg ${
          danger ? "bg-danger/15 text-danger" : "bg-ink-800 text-ink-400"
        }`}
      >
        {icon}
      </div>
      <div className="text-sm font-medium text-ink-200">{title}</div>
      {desc && <div className="mt-1 max-w-72 text-11 leading-relaxed text-ink-400">{desc}</div>}
      {steps && steps.length > 0 && (
        <ol className="mt-2.5 max-w-72 space-y-1.5 text-left">
          {steps.map((st, i) => (
            <li key={st} className="flex gap-2 text-11 leading-relaxed text-ink-300">
              <span className="mt-0.5 flex h-4 w-4 flex-none items-center justify-center rounded-full bg-ink-800 font-mono text-10 text-ink-300">
                {i + 1}
              </span>
              {st}
            </li>
          ))}
        </ol>
      )}
      {action && (
        <button className="btn btn-accent mt-4" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  );
}
