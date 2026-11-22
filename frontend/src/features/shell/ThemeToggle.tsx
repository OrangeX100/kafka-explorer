import { Moon, Sun } from "lucide-react";
import { useTheme } from "../../shared/theme.js";
import { t } from "../../shared/i18n.js";

// ThemeToggle lives in the activity rail's tail — icon-only with a tooltip.
export function ThemeToggle() {
  const { resolved, toggle } = useTheme();
  return (
    <button
      className="flex h-10 w-10 items-center justify-center rounded text-ink-300 transition-colors hover:bg-ink-800 hover:text-ink-100"
      title={t("sidebar.theme")}
      onClick={toggle}
    >
      {/* 按 resolved 判定：system 模式下旧逻辑恒显示 Moon，即使系统当前
          是 light（0.4.21 评审 P3） */}
      {resolved() === "dark" ? <Sun size={16} /> : <Moon size={16} />}
    </button>
  );
}
