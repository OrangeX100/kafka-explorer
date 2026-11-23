import { useState } from "react";
import { adminApi, friendlyError } from "../../shared/api.js";
import { useToast } from "../../state/stores.js";
import { t } from "../../shared/i18n.js";
import { Modal } from "../common/Modal.js";

// ExpandPartitionsDialog: grow a topic's partition count. Kafka only allows
// growing — the input floor is current+1 and the backend re-validates against
// the live count. New partitions' replica assignment is broker-chosen.
export function ExpandPartitionsDialog({
  connectionId,
  topic,
  current,
  onClose,
  onSaved,
}: {
  connectionId: string;
  topic: string;
  current: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [target, setTarget] = useState(String(current + 1));
  const toast = useToast((s) => s.show);
  const parsed = Number(target);
  const valid = Number.isInteger(parsed) && parsed > current && parsed <= 20000;
  // 行内实时校验（0.4.22 交互统一）：静默禁用按钮曾让"填小了"无任何反馈，
  // 用户不知道为什么点不动——中文提示先行，按钮禁用保持
  const invalidReason =
    target.trim() === ""
      ? t("config.expandErrEmpty")
      : !Number.isInteger(parsed)
        ? t("config.expandErrNotInt")
        : parsed <= current
          ? t("config.expandErrTooLow", String(current))
          : parsed > 20000
            ? t("config.expandErrTooHigh")
            : "";

  const submit = async () => {
    try {
      await adminApi.increasePartitions(connectionId, topic, parsed);
      toast(t("config.expandOk", String(parsed)), "ok");
      onSaved();
      onClose();
    } catch (err) {
      toast(friendlyError(err), "error");
    }
  };

  return (
    <Modal title={t("config.expandTitle", topic)} width={430} onClose={onClose}>
      {(close) => (
        <div className="space-y-2.5">
          <p className="rounded bg-warn/10 border border-warn/40 px-2.5 py-1.5 text-11 text-ink-200">
            {t("config.expandWarn", String(current))}
          </p>
          <label className="block">
            <span className="mb-1 block text-11 text-ink-300">{t("config.expandTarget", String(current))}</span>
            <input
              className="field"
              type="number"
              min={current + 1}
              max={20000}
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            />
            {invalidReason !== "" && (
              <span className="mt-1 block text-10 text-danger">{invalidReason}</span>
            )}
          </label>
          <div className="mt-3 flex items-center gap-2 border-t border-ink-700 pt-3">
            <div className="flex-1" />
            <button className="btn" onClick={close}>
              {t("conn.cancel")}
            </button>
            <button className="btn btn-accent" disabled={!valid} onClick={() => void submit()}>
              {t("config.expandSubmit")}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
