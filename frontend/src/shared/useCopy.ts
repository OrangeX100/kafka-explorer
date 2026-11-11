// Shared clipboard helper: write + localized ok toast, with the one
// failure-aware catch (msg.copyFail) all inline call sites used to skip.
import { useCallback } from "react";
import { t } from "./i18n.js";
import { useToast } from "../state/stores.js";

export function useCopy() {
  const toast = useToast();
  return useCallback(
    (text: string) => {
      navigator.clipboard
        .writeText(text)
        .then(() => toast.show(t("common.copied"), "ok"))
        .catch(() => toast.show(t("msg.copyFail"), "error"));
    },
    [toast]
  );
}
