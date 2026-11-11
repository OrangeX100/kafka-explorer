import { t } from "../../shared/i18n.js";
import { useEffect, useState } from "react";
import { systemApi } from "../../shared/api.js";
import { Minus, Square, Copy, X } from "lucide-react";
import { Window } from "@wailsio/runtime";

// TitleBar: custom frameless-window titlebar that merges with the app
// surface (no native Windows chrome). The whole bar drags the window via
// --wails-draggable: drag; double-click toggles maximise; the three
// window buttons sit in a no-drag zone on the right.
export function TitleBar() {
  const [maximised, setMaximised] = useState(false);

  // DOM resize fires when the window toggles maximised, so polling the
  // runtime here keeps the restore/maximise icon honest without extra
  // event plumbing.
  useEffect(() => {
    const sync = () => void Window.IsMaximised().then(setMaximised);
    sync();
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, []);

  return (
    <div
      className="flex h-8 flex-none items-center border-b border-ink-700 bg-ink-900 pl-2 select-none"
      style={{ "--wails-draggable": "drag" } as React.CSSProperties}
      onDoubleClick={() => void Window.ToggleMaximise()}
    >
      <img src="/appicon.png" alt="" className="mr-2 h-4 w-4" draggable={false} />
      <span className="text-11 font-medium tracking-wide text-ink-300">Kafka Explorer</span>
      {/* flex-1 spacer STAYS draggable — the no-drag zone covers only the
          three buttons, otherwise the whole bar becomes undraggable */}
      <div className="flex-1 self-stretch" />
      <div
        className="flex flex-none items-stretch self-stretch"
        style={{ "--wails-draggable": "no-drag" } as React.CSSProperties}
      >
        <TitleBarButton
          label={t("titlebar.minimize")}
          onClick={() => void Window.Minimise()}
          icon={<Minus size={14} />}
        />
        <TitleBarButton
          label={maximised ? t("titlebar.restore") : t("titlebar.maximize")}
          onClick={() => void Window.ToggleMaximise()}
          icon={maximised ? <Copy size={12} /> : <Square size={12} />}
        />
        <TitleBarButton
          label={t("titlebar.close")}
          onClick={() => systemApi.closeToTray()}
          icon={<X size={14} />}
          danger
        />
      </div>
    </div>
  );
}

function TitleBarButton({
  label,
  onClick,
  icon,
  danger,
}: {
  label: string;
  onClick: () => void;
  icon: React.ReactNode;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      onClick={onClick}
      onDoubleClick={(e) => e.stopPropagation()}
      className={`flex w-11 items-center justify-center text-ink-300 transition-colors ${
        danger ? "hover:bg-danger hover:text-white" : "hover:bg-ink-700 hover:text-ink-100"
      }`}
    >
      {icon}
    </button>
  );
}
