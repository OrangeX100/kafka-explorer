import { create } from "zustand";
import { TriangleAlert } from "lucide-react";
import { Modal } from "./Modal.js";
import { t } from "../../shared/i18n.js";

export interface ConfirmOptions {
  title?: string;
  message: string;
  danger?: boolean;
  confirmLabel?: string;
}

interface ConfirmRequest extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

const useConfirmStore = create<{ req: ConfirmRequest | null }>(() => ({ req: null }));

// Promise-based styled confirmation. Every destructive action goes through
// here — window.confirm renders the WebView's native dialog, which clashes
// with the app shell and cannot be themed.
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    // 单槽覆盖前先 resolve 前一个等待者（false）：旧实现让前一个 promise
    // 永久挂起——第一个 confirm 的调用方（如删除流程）静默丢失
    // （0.4.21 评审 P3）
    useConfirmStore.setState((cur) => {
      cur.req?.resolve(false);
      return { req: { ...opts, resolve } };
    });
  });
}

// Mounted once in App. The confirm button resolves true then closes; cancel,
// backdrop and Escape just close, and onClose resolves false (resolving an
// already-settled promise is a no-op, so the double call is safe).
export function ConfirmHost() {
  const req = useConfirmStore((s) => s.req);
  if (!req) return null;
  return (
    <Modal
      title={req.title ?? t("common.confirmTitle")}
      width={420}
      onClose={() => {
        req.resolve(false);
        useConfirmStore.setState({ req: null });
      }}
    >
      {(close) => (
        <div>
          <div className="flex items-start gap-2.5 text-xs leading-relaxed text-ink-200">
            {req.danger && <TriangleAlert size={16} className="mt-0.5 flex-none text-danger" />}
            <span className="selectable">{req.message}</span>
          </div>
          <div className="mt-4 flex justify-end gap-2 border-t border-ink-700 pt-3">
            <button className="btn" onClick={close}>
              {t("common.cancel")}
            </button>
            <button
              autoFocus
              className={`btn ${req.danger ? "btn-danger" : "btn-accent"}`}
              onClick={() => {
                req.resolve(true);
                close();
              }}
            >
              {req.confirmLabel ?? t("common.confirm")}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
