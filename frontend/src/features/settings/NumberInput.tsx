import { useEffect, useRef, useState } from "react";

// NumberInput: draft-string numeric field. The raw set() path used to push
// the CLEARING state (Number("")=0) into settings, the backend clamped it
// (0→50) and the echo rewrote the input mid-typing — "I typed 1500 and it
// became 50x". Draft commits only on blur/Enter, so intermediate states
// never reach settings and never echo back (0.4.21 review P2-3).
export function NumberInput({
  value,
  min,
  max,
  width,
  commit,
}: {
  value: number;
  min: number;
  max: number;
  width: string;
  commit: (n: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const dirtyRef = useRef(false);
  useEffect(() => {
    // 外部回填（备份导入等）且用户没有正在编辑：跟随新值
    if (!dirtyRef.current) setDraft(String(value));
  }, [value]);
  const commitDraft = () => {
    dirtyRef.current = false;
    const n = Number(draft);
    if (!Number.isFinite(n)) {
      setDraft(String(value));
      return;
    }
    commit(Math.min(max, Math.max(min, Math.round(n))));
  };
  return (
    <input
      className={`field ${width}`}
      type="number"
      min={min}
      max={max}
      value={draft}
      onChange={(e) => {
        dirtyRef.current = true;
        setDraft(e.target.value);
      }}
      onBlur={commitDraft}
      onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
    />
  );
}
