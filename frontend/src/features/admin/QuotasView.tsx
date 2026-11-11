import { useCallback, useEffect, useState } from "react";
import { Copy, Gauge, Plus, Trash2 } from "lucide-react";
import { Modal } from "../common/Modal.js";
import { Select } from "../common/controls.js";
import { confirmDialog } from "../common/ConfirmDialog.js";
import { adminApi, friendlyError } from "../../shared/api.js";
import { useToast } from "../../state/stores.js";
import { t } from "../../shared/i18n.js";
import { SkeletonLines } from "../common/Skeleton.js";
import { EmptyState } from "../common/EmptyState.js";
import type { Quota } from "../../shared/contracts-admin.js";
import { ErrorHint } from "../common/ErrorHint.js";
import { useContextMenu } from "../common/ContextMenu.js";
import { useCopy } from "../../shared/useCopy.js";

// QuotasView: read + edit client quotas (producer/consumer byte rate, request %).
export function QuotasView({ connectionId }: { connectionId: string }) {
  const [quotas, setQuotas] = useState<Quota[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setQuotas(null);
    try {
      setQuotas((await adminApi.listQuotas(connectionId)) ?? []);
    } catch (err) {
      setQuotas([]);
      setLoadError(err);
    }
  }, [connectionId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="h-full overflow-auto">
      <div className="flex items-center gap-1.5 border-b border-ink-700 bg-ink-900 px-2 py-1.5">
        <button className="btn btn-accent" onClick={() => setCreating(true)}>
          <Plus size={13} /> {t("quotas.create")}
        </button>
        <div className="flex-1" />
        <button className="btn" onClick={() => void load()}>↻</button>
      </div>
      {quotas === null && (
        <div className="p-3">
          <SkeletonLines rows={4} />
        </div>
      )}
      {loadError !== null && (
        <div className="w-full max-w-xl px-6 py-6">
          <ErrorHint error={loadError} onRetry={() => void load()} />
        </div>
      )}
      {!loadError && quotas !== null && quotas.length === 0 && (
        <EmptyState icon={<Gauge size={20} />} title={t("ws.quotas")} desc={t("quotas.empty")} />
      )}
      {(quotas ?? []).length > 0 && (
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-ink-700 bg-ink-900 text-left text-11 text-ink-300">
              <th className="px-3 py-1.5 font-medium">{t("quotas.colEntity")}</th>
              <th className="px-2 py-1.5 font-medium">{t("quotas.colKey")}</th>
              <th className="px-2 py-1.5 font-medium">{t("config.value")}</th>
              <th className="px-2 py-1.5 text-center font-medium">{t("quotas.colActions")}</th>
            </tr>
          </thead>
          <tbody>
            {(quotas ?? []).flatMap((q, qi) =>
              Object.entries(q.values).map(([k, v], ki) => (
                <QuotaKeyRow
                  key={`${qi}-${k}`}
                  connectionId={connectionId}
                  entity={q.entity}
                  quotaKey={k}
                  value={v}
                  entityLabel={Object.entries(q.entity).map(([ek, ev]) => `${ek}=${ev || "(default)"}`).join(", ")}
                  first={ki === 0}
                  rowCount={Object.keys(q.values).length}
                  onChanged={() => void load()}
                />
              )),
            )}
          </tbody>
        </table>
      )}
      {creating && (
        <CreateQuotaDialog
          connectionId={connectionId}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            void load();
          }}
        />
      )}
    </div>
  );
}

const QUOTA_KEYS = [
  { value: "producer_byte_rate", label: "producer_byte_rate" },
  { value: "consumer_byte_rate", label: "consumer_byte_rate" },
  { value: "request_percentage", label: "request_percentage" },
];

// CreateQuotaDialog: set a quota for a NEW entity (setting a value on an
// entity that has no quotas yet creates the entry — the broker API is
// upsert). Entity dimension is user / client-id / ip.
function CreateQuotaDialog({
  connectionId,
  onClose,
  onCreated,
}: {
  connectionId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [entityType, setEntityType] = useState("client-id");
  const [entityName, setEntityName] = useState("");
  const [key, setKey] = useState("producer_byte_rate");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const closeRef = { current: onClose };

  const create = async () => {
    setBusy(true);
    try {
      const entity: Record<string, string> =
        entityType === "ip" ? { "ip": entityName } : { [entityType]: entityName };
      await adminApi.alterQuota(connectionId, entity, key, Number(value));
      toast.show(t("quotas.created", `${entityType}=${entityName || "default"}`, key, value), "ok");
      onCreated();
    } catch (err) {
      toast.show(friendlyError(err), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={t("quotas.create")} width={460} onClose={onClose}>
      {(close) => {
        closeRef.current = close;
        return (
          <div className="space-y-2.5">
            <p className="rounded border border-ink-700 bg-ink-900 px-2.5 py-2 text-11 leading-relaxed text-ink-300">
              {t("quotas.intro")}
            </p>
            <div className="grid grid-cols-2 gap-2.5">
              <label className="block">
                <span className="mb-1 block text-11 text-ink-300">{t("quotas.entityType")}</span>
                <div className="min-h-[26px]">
                  <Select
                    className="!w-full"
                    value={entityType}
                    options={[
                      { value: "client-id", label: "Client ID" },
                      { value: "user", label: "User" },
                      { value: "ip", label: "IP" },
                    ]}
                    onChange={(v) => setEntityType(v)}
                  />
                </div>
              </label>
              <label className="block">
                <span className="mb-1 block text-11 text-ink-300">{t("quotas.entityName")}</span>
                <input className="field font-mono" value={entityName} onChange={(e) => setEntityName(e.target.value)} />
              </label>
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              <label className="block">
                <span className="mb-1 block text-11 text-ink-300">{t("quotas.keyLabel")}</span>
                <div className="min-h-[26px]">
                  <Select className="!w-full" value={key} options={QUOTA_KEYS} onChange={(v) => setKey(v)} />
                </div>
              </label>
              <label className="block">
                <span className="mb-1 block text-11 text-ink-300">{t("quotas.valueLabel")}</span>
                <input
                  className="field font-mono"
                  type="number"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                />
              </label>
            </div>
            {/* keyed caption: key={key} keeps the swap animation clean and
                stops the text jump the user saw as "页面抖一下" */}
            <p key={key} className="text-10 leading-relaxed text-ink-400 anim-fade">
              {t(`quotas.key.${key}`)}
            </p>
            <div className="mt-3 flex justify-end gap-2 border-t border-ink-700 pt-3">
              <button className="btn" onClick={close}>
                {t("conn.cancel")}
              </button>
              <button
                className="btn btn-accent"
                disabled={busy || !entityName || !value || Number.isNaN(Number(value))}
                onClick={() => void create()}
              >
                {t("conn.save")}
              </button>
            </div>
          </div>
        );
      }}
    </Modal>
  );
}

function QuotaKeyRow({
  connectionId,
  entity,
  quotaKey,
  value,
  entityLabel,
  first,
  rowCount,
  onChanged,
}: {
  connectionId: string;
  entity: Record<string, string>;
  quotaKey: string;
  value: number | null;
  entityLabel: string;
  first: boolean;
  rowCount: number;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState<string>(String(value ?? ""));
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const { open: openCtx, menu: ctxMenu } = useContextMenu();
  const copy = useCopy();

  const rowMenu = (e: React.MouseEvent) =>
    openCtx(e, [
      { label: t("ctx.copyEntity"), icon: <Copy size={13} />, onSelect: () => copy(entityLabel) },
      { label: t("ctx.copyKeyName"), icon: <Copy size={13} />, onSelect: () => copy(quotaKey) },
      { label: t("quotas.deleteKey"), danger: true, separatorBefore: true, onSelect: () => void deleteKey() },
    ]);

  const alter = async (newValue: number | null) => {
    setBusy(true);
    try {
      await adminApi.alterQuota(connectionId, entity, quotaKey, newValue);
      onChanged();
    } catch (err) {
      toast.show(friendlyError(err), "error");
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    const raw = editing.trim();
    if (raw === String(value ?? "")) return;
    const num = Number(raw);
    if (!Number.isFinite(num)) {
      toast.show(t("error.invalid"), "error");
      return;
    }
    await alter(num);
    toast.show(t("quotas.saved", entityLabel, quotaKey, String(num)), "ok");
  };

  const deleteKey = async () => {
    const ok = await confirmDialog({
      message: t("quotas.deleteKeyConfirm", entityLabel, quotaKey),
      danger: true,
    });
    if (!ok) return;
    await alter(null);
    toast.show(t("quotas.deletedKey", quotaKey), "ok");
  };

  const deleteEntity = async () => {
    const ok = await confirmDialog({
      message: t("quotas.deleteEntityConfirm", entityLabel),
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      for (const k of Object.keys(QUOTA_KEY_SET)) {
        if (QUOTA_KEY_SET.has(k)) {
          await adminApi.alterQuota(connectionId, entity, k, null);
        }
      }
      toast.show(t("quotas.deletedEntity", entityLabel), "ok");
      onChanged();
    } catch (err) {
      toast.show(friendlyError(err), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <tr className="group border-b border-ink-800 hover:bg-ink-850" onContextMenu={rowMenu}>
      <td className="px-3 py-1.5 font-mono text-accent" rowSpan={first ? rowCount : undefined}>
        <span className="block truncate" title={entityLabel}>
          {entityLabel}
        </span>
      </td>
      <td className="px-2 py-1.5 font-mono text-ink-200" title={t(`quotas.key.${quotaKey}`)}>
        {quotaKey}
      </td>
      <td className="px-2 py-1.5">
        <input
          className="field !w-28 !py-0.5 font-mono text-11"
          value={editing}
          onChange={(e) => setEditing(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void save()}
          onBlur={() => void save()}
          title={t("quotas.editHint")}
        />
      </td>
      <td className="px-2 py-1.5 text-center">
        <div className="flex items-center justify-center gap-1">
          <button
            className="btn !px-1.5 !py-0.5 text-10 opacity-70 hover:!text-danger group-hover:opacity-100"
            disabled={busy}
            title={t("quotas.deleteKey")}
            onClick={() => void deleteKey()}
          >
            <Trash2 size={11} /> {t("quotas.deleteKeyShort")}
          </button>
          {first && rowCount > 0 && (
            <button
              className="btn !px-1.5 !py-0.5 text-10 opacity-70 hover:!text-danger"
              disabled={busy}
              title={t("quotas.deleteEntity")}
              onClick={() => void deleteEntity()}
            >
              <Trash2 size={11} /> {t("quotas.deleteEntityShort")}
            </button>
          )}
        </div>
      </td>
      {ctxMenu}
    </tr>
  );
}



const QUOTA_KEY_SET = new Set(QUOTA_KEYS.map((k) => k.value));


// CreateQuotaDialog: set a quota for a NEW entity (setting a value on an
// entity that has no quotas yet creates the entry — the broker API is
// upsert). Entity dimension is user / client-id / ip.
