import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import { clientToLayout, uiZoom, viewportH, viewportW } from "../../shared/zoom.js";

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  separatorBefore?: boolean;
  // Grayed out: not clickable, skipped by keyboard navigation.
  disabled?: boolean;
  onSelect: () => void;
}

// useContextMenu: right-click hook returning (open, menu) where open binds
// to onContextMenu. The menu renders in a portal at the cursor, closes on
// click-away / Escape / scroll, and clamps inside the viewport.
export function useContextMenu() {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [items, setItems] = useState<MenuItem[]>([]);
  const menuRef = useRef<HTMLDivElement>(null);

  const open = useCallback((e: React.MouseEvent, menuItems: MenuItem[]) => {
    e.preventDefault();
    e.stopPropagation();
    // clientX/Y are viewport pixels; the body may be zoomed (界面字号), so
    // convert into layout pixels before positioning.
    setItems(menuItems);
    setPos({ x: clientToLayout(e.clientX), y: clientToLayout(e.clientY) });
  }, []);

  const close = useCallback(() => setPos(null), []);

  useEffect(() => {
    if (pos === null) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [pos, close]);

  const menu =
    pos !== null ? (
      <ContextMenuSurface menuRef={menuRef} pos={pos} items={items} onClose={close} />
    ) : null;

  return { open, menu };
}

const ContextMenuSurface = ({
  menuRef,
  pos,
  items,
  onClose,
}: {
  menuRef: React.RefObject<HTMLDivElement | null>;
  pos: { x: number; y: number };
  items: MenuItem[];
  onClose: () => void;
}) => {
  // Clamp within viewport after first paint (menu size unknown before).
  const [clamped, setClamped] = useState(pos);
  useEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    // rect is in visual px (zoom-scaled); menu pos is in layout px — convert.
    const z = uiZoom();
    const r = el.getBoundingClientRect();
    setClamped({
      x: Math.min(pos.x, viewportW() - r.width / z - 8),
      y: Math.min(pos.y, viewportH() - r.height / z - 8),
    });
    // Keyboard support: roving focus over the enabled menu items. Buttons
    // activate on Enter/Space natively.
    const first = el.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not([disabled])')[0];
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      const all = [...el.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not([disabled])')];
      if (all.length === 0) return;
      const idx = all.indexOf(document.activeElement as HTMLButtonElement);
      const move = (next: number) => {
        e.preventDefault();
        all[(next + all.length) % all.length].focus();
      };
      if (e.key === "ArrowDown") move(idx + 1);
      else if (e.key === "ArrowUp") move(idx - 1);
      else if (e.key === "Home") move(0);
      else if (e.key === "End") move(all.length - 1);
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  }, [pos, menuRef]);

  return createPortal(
    <div
      ref={menuRef as React.RefObject<HTMLDivElement>}
      role="menu"
      className="anim-fade fixed z-[100] min-w-44 rounded border border-ink-600 bg-ink-850 py-1 shadow-2xl"
      style={{ left: clamped.x, top: clamped.y }}
    >
      {items.map((item, i) => (
        <div key={i}>
          {item.separatorBefore && i > 0 && <div className="mx-2 my-1 h-px bg-ink-700" />}
          <button
            role="menuitem"
            disabled={item.disabled}
            className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
              item.disabled
                ? "cursor-default text-ink-500"
                : item.danger
                  ? "text-danger hover:bg-danger/15"
                  : "text-ink-100 hover:bg-ink-700"
            }`}
            onClick={() => {
              if (item.disabled) return;
              onClose();
              item.onSelect();
            }}
          >
            {item.icon}
            {item.label}
          </button>
        </div>
      ))}
    </div>,
    document.body
  );
};
