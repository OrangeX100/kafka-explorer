import { useCallback, useEffect, useState } from "react";
import { FileCode, PlugZap, Plus, Trash2, Copy, Pencil, RefreshCw } from "lucide-react";
import { registryApi } from "../../shared/api.js";
import { friendlyError } from "../../shared/api.js";
import { useToast } from "../../state/stores.js";
import { t } from "../../shared/i18n.js";
import { confirmDialog } from "../common/ConfirmDialog.js";
import { SkeletonLines } from "../common/Skeleton.js";
import { EmptyState } from "../common/EmptyState.js";
import { ErrorHint } from "../common/ErrorHint.js";
import { useContextMenu } from "../common/ContextMenu.js";
import { useCopy } from "../../shared/useCopy.js";
import { GlidingTabs } from "../common/GlidingTabs.js";
import type { SchemaRegistry, SchemaSubject } from "../../shared/contracts-admin.js";
import { RegistryDialog } from "./RegistryDialogs.js";
import { SchemaDetail } from "./RegistryDetail.js";
import { LocalSchemas } from "./LocalSchemas.js";

// RegistryView: the Schema Registry workspace, shaped: registry rail →
// subjects rail → detail pane (schema/versions/compatibility/diff), plus a
// local-schema library mode for offline decoding. Registry rows carry a
// liveness dot (best-effort version probe) and an edit action.
type Mode = "remote" | "local";

// health probes are cached per registry id: ok → "7.9.2", failure → null
type Health = Map<string, string | null>;

export function RegistryView() {
  const [mode, setMode] = useState<Mode>("remote");
  const [registries, setRegistries] = useState<SchemaRegistry[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [health, setHealth] = useState<Health>(new Map());
  const [subjects, setSubjects] = useState<SchemaSubject[] | null>(null);
  const [subjectsError, setSubjectsError] = useState<unknown>(null);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<SchemaSubject | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<SchemaRegistry | null>(null);
  const toast = { show: useToast((s) => s.show) };

  const load = useCallback(async () => {
    setRegistries(null);
    setLoadError(null);
    try {
      const list = (await registryApi.list()) ?? [];
      setRegistries(list);
      setActiveId((cur) => (cur && list.some((r) => r.id === cur) ? cur : list[0]?.id ?? null));
      // Liveness probe per registry — one short call each; a dead registry
      // shows a red dot instead of failing the whole rail.
      const next: Health = new Map();
      await Promise.all(
        list.map(async (r) => {
          try {
            next.set(r.id, await registryApi.test(r));
          } catch {
            next.set(r.id, null);
          }
        }),
      );
      setHealth(next);
    } catch (err) {
      setLoadError(err);
      setRegistries([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const loadSubjects = useCallback(async (id: string) => {
    setSubjects(null);
    setSelected(null);
    setSubjectsError(null);
    try {
      setSubjects((await registryApi.subjects(id)) ?? []);
    } catch (err) {
      setSubjectsError(err);
      setSubjects([]);
    }
  }, []);

  useEffect(() => {
    if (activeId && mode === "remote") void loadSubjects(activeId);
  }, [activeId, mode, loadSubjects]);

  const removeRegistry = async (r: SchemaRegistry) => {
    if (!(await confirmDialog({ message: t("reg.deleteConfirm", r.name), danger: true }))) return;
    await registryApi.remove(r.id);
    setActiveId(null);
    await load();
  };

  const testOne = async (r: SchemaRegistry) => {
    try {
      const version = await registryApi.test(r);
      setHealth((h) => new Map(h).set(r.id, version));
      toast.show(t("reg.testOk", version), "ok");
    } catch (err) {
      setHealth((h) => new Map(h).set(r.id, null));
      toast.show(friendlyError(err), "error");
    }
  };

  const removeSubject = async (subject: SchemaSubject, permanent: boolean) => {
    if (!activeId) return;
    await registryApi.deleteSubject(activeId, subject.name, permanent);
  };

  const { open: openCtx, menu: ctxMenu } = useContextMenu();
  const copy = useCopy();

  const visible = (subjects ?? []).filter((s) => s.name.toLowerCase().includes(filter.toLowerCase()));

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-ink-950">
      <div className="flex items-center gap-2 border-b border-ink-700 bg-ink-900 px-2 py-1.5">
        <GlidingTabs
          small
          tabs={[
            { value: "remote", label: t("reg.modeRemote") },
            { value: "local", label: t("reg.modeLocal") },
          ]}
          value={mode}
          onChange={(v) => setMode(v as Mode)}
        />
        <div className="flex-1" />
        {mode === "remote" && (
          <button className="btn btn-accent" onClick={() => setCreating(true)}>
            <Plus size={13} /> {t("sidebar.addRegistry")}
          </button>
        )}
      </div>

      {mode === "local" ? (
        <LocalSchemas />
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* registry rail */}
          <div className="w-60 flex-none overflow-y-auto border-r border-ink-700 bg-ink-900 py-1">
            {registries === null && !loadError && (
              <div className="px-3 py-3">
                <SkeletonLines rows={3} />
              </div>
            )}
            {loadError ? (
              <div className="px-2 py-2">
                <ErrorHint error={loadError} onRetry={() => void load()} compact />
              </div>
            ) : null}
            {(registries ?? []).map((r) => {
              const v = health.get(r.id);
              return (
                <div
                  key={r.id}
                  data-testid="registry-row"
                  onContextMenu={(e) =>
                    openCtx(e, [
                      { label: t("ctx.openRegistry"), onSelect: () => setActiveId(r.id) },
                      { label: t("reg.editRegistry"), icon: <Pencil size={13} />, onSelect: () => setEditing(r) },
                      { label: t("reg.test"), icon: <PlugZap size={13} />, onSelect: () => void testOne(r) },
                      { label: t("ctx.copyUrl"), icon: <Copy size={13} />, onSelect: () => copy(r.url) },
                      {
                        label: t("ctx.deleteRegistry"),
                        icon: <Trash2 size={13} />,
                        danger: true,
                        separatorBefore: true,
                        onSelect: () => void removeRegistry(r),
                      },
                    ])
                  }
                  onClick={() => setActiveId(r.id)}
                  className={`group flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs ${
                    activeId === r.id ? "bg-accent-muted text-ink-100" : "text-ink-200 hover:bg-ink-800"
                  }`}
                >
                  <span
                    className={`h-2 w-2 flex-none rounded-full ${v === undefined ? "bg-ink-600" : v ? "bg-ok" : "bg-danger"}`}
                    title={v === undefined ? t("reg.probing") : v ? t("reg.healthOk", v) : t("reg.healthFail")}
                  />
                  <FileCode size={13} className="flex-none text-ink-400" />
                  <span className="flex-1 truncate">{r.name}</span>
                  <span className="flex-none opacity-0 transition-opacity group-hover:opacity-100">
                    <button
                      className="text-ink-400 hover:text-ink-100"
                      title={t("reg.editRegistry")}
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditing(r);
                      }}
                    >
                      <Pencil size={11} />
                    </button>
                  </span>
                </div>
              );
            })}
            {registries !== null && !loadError && registries.length === 0 && (
              <div className="px-3 py-4 text-xs text-ink-400">{t("reg.empty")}</div>
            )}
          </div>

          {/* subjects rail */}
          <div className="flex w-72 flex-none flex-col border-r border-ink-700">
            <div className="flex items-center gap-1.5 border-b border-ink-700 px-2 py-1.5">
              <span className="px-1 text-11 text-ink-300">{t("reg.subjects")}</span>
              <div className="flex-1" />
              <button className="btn !py-0.5 !px-1.5" title={t("common.refresh")} onClick={() => activeId && void loadSubjects(activeId)}>
                <RefreshCw size={11} />
              </button>
            </div>
            <div className="border-b border-ink-800 px-2 py-1.5">
              <input
                className="field"
                placeholder={t("reg.searchPh")}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {subjects === null && activeId && !subjectsError && (
                <div className="p-3">
                  <SkeletonLines rows={6} />
                </div>
              )}
              {subjectsError ? (
                <div className="p-3">
                  <ErrorHint error={subjectsError} onRetry={() => activeId && void loadSubjects(activeId)} />
                </div>
              ) : null}
              {subjects !== null && !subjectsError && subjects.length === 0 && (
                <EmptyState icon={<FileCode size={18} />} title={t("reg.noSubjects")} desc={t("reg.noSubjectsHint")} />
              )}
              {subjects !== null && !subjectsError && subjects.length > 0 && visible.length === 0 && (
                <div className="px-3 py-4 text-xs text-ink-400">{t("reg.filterEmpty")}</div>
              )}
              {visible.map((s) => (
                <div
                  key={s.name}
                  onContextMenu={(e) =>
                    openCtx(e, [
                      { label: t("ctx.viewSchema"), onSelect: () => setSelected(s) },
                      { label: t("ctx.copySubject"), icon: <Copy size={13} />, onSelect: () => copy(s.name) },
                      { label: t("reg.deleteSubject"), danger: true, separatorBefore: true, onSelect: () => void removeFlow(s, false) },
                      { label: t("reg.deleteSubjectPermanentAction"), danger: true, onSelect: () => void removeFlow(s, true) },
                    ])
                  }
                  onClick={() => setSelected(s)}
                  className={`cursor-pointer px-3 py-1.5 text-xs ${
                    selected?.name === s.name ? "bg-accent-muted text-ink-100" : "text-ink-200 hover:bg-ink-800"
                  }`}
                >
                  <div className="truncate font-mono" title={s.name}>
                    {s.name}
                  </div>
                  <div className="text-10 text-ink-400">
                    v{s.version} · {s.schemaType}
                    {s.compatibility ? <> · {s.compatibility}</> : null}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* detail */}
          <div className="min-w-0 flex-1">
            {selected ? (
              <SchemaDetail
                registryId={activeId!}
                subject={selected}
                onDeleted={() => activeId && loadSubjects(activeId)}
                onRemove={removeSubject}
              />
            ) : (
              <EmptyState icon={<FileCode size={20} />} title={t("reg.schema")} desc={t("reg.pickSubject")} />
            )}
          </div>
        </div>
      )}

      {ctxMenu}
      {creating && (
        <RegistryDialog
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            void load();
          }}
        />
      )}
      {editing && (
        <RegistryDialog
          existing={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
    </main>
  );

  async function removeFlow(s: SchemaSubject, permanent: boolean) {
    const message = permanent ? t("reg.deleteSubjectPermanent", s.name) : t("reg.deleteSubjectConfirm", s.name);
    if (!(await confirmDialog({ message, danger: true }))) return;
    try {
      await removeSubject(s, permanent);
      toast.show(permanent ? t("reg.deletedPermanent") : t("reg.deleted"), "ok");
      if (activeId) await loadSubjects(activeId);
    } catch (err) {
      toast.show(friendlyError(err), "error");
    }
  }
}
