import { useCallback, useEffect, useState } from "react";
import { BookMarked, Copy, Pencil, Plus, Trash2 } from "lucide-react";
import { SkeletonLines } from "../common/Skeleton.js";
import { EmptyState } from "../common/EmptyState.js";
import { ErrorHint } from "../common/ErrorHint.js";
import { confirmDialog } from "../common/ConfirmDialog.js";
import { useContextMenu } from "../common/ContextMenu.js";
import { useCopy } from "../../shared/useCopy.js";
import { registryApi } from "../../shared/api.js";
import { friendlyError } from "../../shared/api.js";
import { useToast } from "../../state/stores.js";
import { t } from "../../shared/i18n.js";
import type { LocalSchema } from "../../shared/contracts-admin.js";
import { LocalSchemaDialog } from "./RegistryDialogs.js";

// LocalSchemas: local schema management — offline schemas stored in
// the app database. They power Confluent-framed decoding when no registry
// connection is configured (message detail → 用本地 Schema 解码).
export function LocalSchemas() {
  const [schemas, setSchemas] = useState<LocalSchema[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [selected, setSelected] = useState<LocalSchema | null>(null);
  const [editing, setEditing] = useState<LocalSchema | null>(null);
  const [creating, setCreating] = useState(false);
  const toast = { show: useToast((s) => s.show) };
  const copy = useCopy();

  const load = useCallback(async () => {
    setSchemas(null);
    setLoadError(null);
    try {
      setSchemas((await registryApi.listLocal()) ?? []);
    } catch (err) {
      setLoadError(err);
      setSchemas([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const remove = async (s: LocalSchema) => {
    if (!(await confirmDialog({ message: t("reg.localDeleteConfirm", s.name), danger: true }))) return;
    try {
      await registryApi.removeLocal(s.id);
      toast.show(t("reg.localDeleted"), "ok");
      if (selected?.id === s.id) setSelected(null);
      await load();
    } catch (err) {
      toast.show(friendlyError(err), "error");
    }
  };

  const { open: openCtx, menu: ctxMenu } = useContextMenu();

  return (
    <div className="flex min-h-0 flex-1">
      <div className="w-64 flex-none overflow-y-auto border-r border-ink-700 bg-ink-900">
        <div className="flex items-center justify-between border-b border-ink-700 px-3 py-1.5 text-11 text-ink-300">
          {t("reg.localList")}
          <button className="btn !py-0.5" title={t("reg.localAdd")} onClick={() => setCreating(true)}>
            <Plus size={12} />
          </button>
        </div>
        {schemas === null && !loadError && (
          <div className="p-3">
            <SkeletonLines rows={4} />
          </div>
        )}
        {loadError ? (
          <div className="p-3">
            <ErrorHint error={loadError} onRetry={() => void load()} />
          </div>
        ) : null}
        {schemas !== null && !loadError && schemas.length === 0 && (
          <EmptyState icon={<BookMarked size={18} />} title={t("reg.localEmpty")} desc={t("reg.localHint")} />
        )}
        {(schemas ?? []).map((s) => (
          <div
            key={s.id}
            onClick={() => setSelected(s)}
            onContextMenu={(e) =>
              openCtx(e, [
                { label: t("reg.localEdit"), icon: <Pencil size={13} />, onSelect: () => setEditing(s) },
                { label: t("ctx.copySchema"), icon: <Copy size={13} />, onSelect: () => copy(s.schema) },
                { label: t("common.delete"), icon: <Trash2 size={13} />, danger: true, separatorBefore: true, onSelect: () => void remove(s) },
              ])
            }
            className={`cursor-pointer px-3 py-1.5 text-xs ${selected?.id === s.id ? "bg-accent-muted text-ink-100" : "text-ink-200 hover:bg-ink-800"}`}
          >
            <div className="flex items-center gap-2">
              <span className="flex-1 truncate" title={s.name}>{s.name}</span>
              <span className="rounded bg-ink-800 px-1.5 py-0.5 text-10 text-ink-300">{s.schemaType}</span>
            </div>
          </div>
        ))}
      </div>
      <div className="min-w-0 flex-1">
        {selected ? (
          <div className="flex h-full flex-col">
            <div className="flex items-center gap-2 border-b border-ink-700 bg-ink-900 px-3 py-1.5">
              <span className="font-mono text-xs text-ink-200">{selected.name}</span>
              <span className="rounded bg-ink-800 px-1.5 py-0.5 text-10 text-ink-300">{selected.schemaType}</span>
              <div className="flex-1" />
              <button className="btn !px-2" onClick={() => setEditing(selected)} title={t("reg.localEdit")}>
                <Pencil size={12} />
              </button>
              <button className="btn btn-danger !px-2" onClick={() => void remove(selected)} title={t("common.delete")}>
                <Trash2 size={12} />
              </button>
            </div>
            <pre className="m-3 flex-1 overflow-auto rounded border border-ink-700 bg-ink-900 p-3 font-mono text-11 leading-relaxed text-ink-100 selectable">
              {selected.schema}
            </pre>
          </div>
        ) : (
          <EmptyState icon={<BookMarked size={20} />} title={t("reg.localHint")} desc={t("reg.localAllTypes")} />
        )}
      </div>
      {ctxMenu}
      {(creating || editing) && (
        <LocalSchemaDialog
          existing={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={() => {
            setCreating(false);
            setEditing(null);
            setSelected(null);
            void load();
          }}
        />
      )}
    </div>
  );
}
