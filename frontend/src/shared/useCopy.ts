// Shared clipboard helper: write + localized ok toast, with the one
// failure-aware catch (msg.copyFail) all inline call sites used to skip.
import { useCallback } from "react";
import { t } from "./i18n.js";
import { useToast } from "../state/stores.js";

export function useCopy() {
  // 稳定 selector：整店订阅 + [toast] 依赖曾让"任意一次 toast 弹出重建
  // copy 并重装全局监听"——历史上 toast 风暴的温床（0.4.21 评审 P3-1）
  const toast = useToast((s) => s.show);
  return useCallback(
    (text: string) => {
      navigator.clipboard
        .writeText(text)
        .then(() => toast(t("common.copied"), "ok"))
        .catch(() => toast(t("msg.copyFail"), "error"));
    },
    [toast]
  );
}
