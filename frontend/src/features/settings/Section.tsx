// Shared section header for the settings page: small icon + label line.
export function SectionTitle({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="mb-2.5 flex items-center gap-1.5 text-11 font-medium text-ink-300">
      {icon}
      {text}
    </div>
  );
}

// Labelled row wrapper (label+optional hint on the left, control on the
// right) — the settings page's only form-row primitive. The label span
// gets min-w-0 so a long hint wraps instead of squeezing the control
// (a w-64 Select needs its full width or its value text clips).
export function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 text-xs">
      <span className="min-w-0 text-ink-300">
        {label}
        {hint && <span className="ml-2 text-10 text-ink-400">{hint}</span>}
      </span>
      <span className="flex-none">{children}</span>
    </div>
  );
}
