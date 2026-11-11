import { useCallback, useEffect, useMemo, useState } from "react";
import { Trash2 } from "lucide-react";
import { GlidingTabs } from "../common/GlidingTabs.js";
import { Select } from "../common/controls.js";
import { SkeletonLines } from "../common/Skeleton.js";
import { ErrorHint } from "../common/ErrorHint.js";
import { confirmDialog } from "../common/ConfirmDialog.js";
import { useContextMenu } from "../common/ContextMenu.js";
import type { MenuItem } from "../common/ContextMenu.js";
import { useCopy } from "../../shared/useCopy.js";
import { registryApi, friendlyError } from "../../shared/api.js";
import { useToast } from "../../state/stores.js";
import { t } from "../../shared/i18n.js";
import type { SchemaSubject, SchemaVersion } from "../../shared/contracts-admin.js";
import { CompatTab } from "./RegistryCompat.js";
import { DiffTab } from "./RegistryDiff.js";

// SchemaDetail: the right pane for one subject — four tabs mirroring the
// SubjectContentPanel: schema viewing with a version picker, version
// history, a compatibility workbench and a two-version diff. Versions load
// once per subject and feed every tab.
type DetailTab = "schema" | "versions" | "compat" | "diff";

export function SchemaDetail({
  registryId,
  subject,
  onDeleted,
  onRemove,
}: {
  registryId: string;
  subject: SchemaSubject;
  onDeleted: () => void;
  onRemove: (subject: SchemaSubject, permanent: boolean) => Promise<void>;
}) {
  const [tab, setTab] = useState<DetailTab>("schema");
  const [versions, setVersions] = useState<SchemaVersion[] | null>(null);
  const [versionsError, setVersionsError] = useState<unknown>(null);
  const [viewing, setViewing] = useState<number>(subject.version);
  const toast = { show: useToast((s) => s.show) };

  const loadVersions = useCallback(async () => {
    setVersions(null);
    setVersionsError(null);
    try {
      setVersions(await registryApi.versions(registryId, subject.name));
    } catch (err) {
      setVersionsError(err);
      setVersions([]);
    }
  }, [registryId, subject.name]);

  useEffect(() => {
    setViewing(subject.version);
    void loadVersions();
  }, [subject.name, subject.version, loadVersions]);

  const removeVersion = async (version: number, permanent: boolean) => {
    const msg = permanent
      ? t("reg.deleteVersionPermanent", subject.name, version)
      : t("reg.deleteVersionConfirm", subject.name, version);
    if (!(await confirmDialog({ message: msg, danger: true }))) return;
    try {
      await registryApi.deleteVersion(registryId, subject.name, version, permanent);
      toast.show(t("reg.versionDeleted"), "ok");
      await loadVersions();
      if (viewing === version) setViewing(subject.version);
    } catch (err) {
      toast.show(friendlyError(err), "error");
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-ink-700 bg-ink-900 px-3 py-1.5">
        <span className="truncate font-mono text-xs text-ink-200" title={subject.name}>
          {subject.name}
        </span>
        <TypeBadge type={subject.schemaType} />
        <CompatChip subject={subject} />
        <div className="flex-1" />
        <GlidingTabs
          small
          tabs={[
            { value: "schema", label: t("reg.tabSchema") },
            { value: "versions", label: t("reg.tabVersions") },
            { value: "compat", label: t("reg.tabCompat") },
            { value: "diff", label: t("reg.tabDiff") },
          ]}
          value={tab}
          onChange={(v) => setTab(v as DetailTab)}
        />
        <button
          className="btn btn-danger !px-2"
          title={t("reg.deleteSubject")}
          onClick={() => void removeSubjectFlow(subject, false, onRemove, onDeleted, toast.show)}
        >
          <Trash2 size={12} />
        </button>
      </div>
      <div key={tab} className="ke-tabpanel flex min-h-0 flex-1 flex-col overflow-hidden">
        {tab === "schema" && (
          <SchemaTab
            subject={subject}
            versions={versions}
            versionsError={versionsError}
            viewing={viewing}
            onView={setViewing}
            onReload={loadVersions}
          />
        )}
        {tab === "versions" && (
          <VersionsTab
            versions={versions}
            versionsError={versionsError}
            onReload={loadVersions}
            latest={subject.version}
            viewing={viewing}
            onView={setViewing}
            onCompare={() => setTab("diff")}
            onDelete={removeVersion}
          />
        )}
        {tab === "compat" && <CompatTab registryId={registryId} subject={subject} versions={versions} />}
        {tab === "diff" && <DiffTab versions={versions} latest={subject.version} subjectName={subject.name} />}
      </div>
    </div>
  );
}

// Soft and permanent removal are two distinct flows with distinct labels —
// the confirm text names exactly what will happen to the stored versions.
async function removeSubjectFlow(
  subject: SchemaSubject,
  permanent: boolean,
  onRemove: (subject: SchemaSubject, permanent: boolean) => Promise<void>,
  onDeleted: () => void,
  show: (msg: string, kind: "ok" | "error") => void,
) {
  const message = permanent ? t("reg.deleteSubjectPermanent", subject.name) : t("reg.deleteSubjectConfirm", subject.name);
  if (!(await confirmDialog({ message, danger: true }))) return;
  try {
    await onRemove(subject, permanent);
    show(permanent ? t("reg.deletedPermanent") : t("reg.deleted"), "ok");
    onDeleted();
  } catch (err) {
    show(friendlyError(err), "error");
  }
}

// ---- tab: schema view ----

function SchemaTab({
  subject,
  versions,
  versionsError,
  viewing,
  onView,
  onReload,
}: {
  subject: SchemaSubject;
  versions: SchemaVersion[] | null;
  versionsError: unknown;
  viewing: number;
  onView: (v: number) => void;
  onReload: () => Promise<void>;
}) {
  const current: SchemaVersion | undefined = useMemo(
    () => versions?.find((v) => v.version === viewing) ?? (viewing === subject.version ? subjectToVersion(subject) : undefined),
    [versions, viewing, subject],
  );
  const copy = useCopy();
  const { open: openCtx, menu: ctxMenu } = useContextMenu();

  if (versionsError) {
    return (
      <div className="p-3">
        <ErrorHint error={versionsError} onRetry={() => void onReload()} />
      </div>
    );
  }
  if (!versions && !current) {
    return (
      <div className="p-3">
        <SkeletonLines rows={8} />
      </div>
    );
  }
  const schemaText = current ? prettySchema(current.schema) : "";
  return (
    <div className="anim-blur-in flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-ink-800 px-3 py-1.5 text-11 text-ink-300">
        <div className="w-44">
          <Select
            value={String(viewing)}
            options={(versions ?? [subjectToVersion(subject)]).map((v) => ({
              value: String(v.version),
              label: `${t("reg.colVersion")} ${v.version} · id=${v.id}`,
            }))}
            onChange={(v) => onView(Number(v))}
          />
        </div>
        <span className="rounded bg-ink-800 px-1.5 py-0.5 font-mono">id={current?.id ?? "?"}</span>
        {current && <TypeBadge type={current.schemaType} />}
        <div className="flex-1" />
        <References refs={subject.references ?? []} onCopy={copy} onCtx={openCtx} />
      </div>
      <pre
        className="m-3 flex-1 overflow-auto rounded border border-ink-700 bg-ink-900 p-3 font-mono text-11 leading-relaxed text-ink-100 selectable"
        onContextMenu={(e) =>
          openCtx(e, [
            { label: t("ctx.copySchema"), onSelect: () => copy(schemaText) },
            { label: t("ctx.copyJsonPretty"), onSelect: () => copy(prettySchema(current?.schema ?? "")) },
          ])
        }
      >
        {schemaText}
      </pre>
      {ctxMenu}
    </div>
  );
}

// ---- tab: version history ----

function VersionsTab({
  versions,
  versionsError,
  onReload,
  latest,
  viewing,
  onView,
  onCompare,
  onDelete,
}: {
  versions: SchemaVersion[] | null;
  versionsError: unknown;
  onReload: () => Promise<void>;
  latest: number;
  viewing: number;
  onView: (v: number) => void;
  onCompare: () => void;
  onDelete: (v: number, permanent: boolean) => Promise<void>;
}) {
  const { open: openCtx, menu: ctxMenu } = useContextMenu();
  const copy = useCopy();
  if (versionsError) {
    return (
      <div className="p-3">
        <ErrorHint error={versionsError} onRetry={() => void onReload()} />
      </div>
    );
  }
  if (!versions) {
    return (
      <div className="p-3">
        <SkeletonLines rows={6} />
      </div>
    );
  }
  return (
    <div className="anim-blur-in min-h-0 flex-1 overflow-auto">
      <table className="w-full text-11">
        <thead className="sticky top-0 bg-ink-900 text-ink-400">
          <tr>
            <th className="px-3 py-1.5 text-left font-medium">{t("reg.colVersion")}</th>
            <th className="px-3 py-1.5 text-left font-medium">{t("reg.colId")}</th>
            <th className="px-3 py-1.5 text-left font-medium">{t("reg.colType")}</th>
            <th className="px-3 py-1.5 text-left font-medium"></th>
          </tr>
        </thead>
        <tbody>
          {versions.map((v) => (
            <tr
              key={v.version}
              className={`cursor-pointer border-t border-ink-800 ${v.version === viewing ? "bg-accent-muted" : "hover:bg-ink-800"}`}
              onClick={() => onView(v.version)}
              onContextMenu={(e) =>
                openCtx(e, [
                  {
                    label: t("ctx.viewVersion"),
                    onSelect: () => {
                      onView(v.version);
                      onCompare();
                    },
                  },
                  { label: t("ctx.copySchema"), onSelect: () => copy(prettySchema(v.schema)) },
                  { label: t("reg.deleteVersion"), danger: true, separatorBefore: true, onSelect: () => void onDelete(v.version, false) },
                ])
              }
            >
              <td className="px-3 py-1.5 font-mono">
                v{v.version}
                {v.version === latest && (
                  <span className="ml-1.5 rounded bg-ok/15 px-1 py-0.5 text-10 text-ok">{t("reg.latest")}</span>
                )}
              </td>
              <td className="px-3 py-1.5 font-mono">{v.id}</td>
              <td className="px-3 py-1.5">
                <TypeBadge type={v.schemaType} />
              </td>
              <td className="px-2 py-1.5 text-right">
                <button
                  className="btn !px-2 text-10"
                  title={t("reg.deleteVersion")}
                  onClick={(e) => {
                    e.stopPropagation();
                    void onDelete(v.version, false);
                  }}
                >
                  <Trash2 size={11} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {ctxMenu}
    </div>
  );
}

// ---- shared bits ----

function TypeBadge({ type }: { type: string }) {
  const color =
    type === "AVRO"
      ? "bg-accent/15 text-accent"
      : type === "JSON"
        ? "bg-ok/15 text-ok"
        : type === "PROTOBUF"
          ? "bg-warn/15 text-warn"
          : "bg-ink-800 text-ink-300";
  return <span className={`rounded px-1.5 py-0.5 text-10 font-medium ${color}`}>{type}</span>;
}

function CompatChip({ subject }: { subject: SchemaSubject }) {
  // Display-only here; changing the level lives in the 兼容性 tab where the
  // semantics can be explained next to the control.
  return (
    <span className="rounded bg-ink-800 px-1.5 py-0.5 text-10 text-ink-300" title={t("reg.compatLevel")}>
      {subject.compatibility || "REGISTRY_DEFAULT"}
    </span>
  );
}

function References({
  refs,
  onCopy,
  onCtx,
}: {
  refs: { name: string; subject: string; version: number }[];
  onCopy: (text: string) => void;
  onCtx: (e: React.MouseEvent, items: MenuItem[]) => void;
}) {
  if (!refs.length) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {refs.map((r) => (
        <span
          key={`${r.subject}:${r.version}`}
          className="rounded bg-ink-800 px-1.5 py-0.5 font-mono text-10 text-ink-300"
          onContextMenu={(e) => onCtx(e, [{ label: t("ctx.copySubject"), onSelect: () => onCopy(r.subject) }])}
        >
          {r.name} → {r.subject} v{r.version}
        </span>
      ))}
    </span>
  );
}

function subjectToVersion(s: SchemaSubject): SchemaVersion {
  return { version: s.version, id: s.id, schemaType: s.schemaType, schema: s.schema };
}

function prettySchema(schema: string): string {
  try {
    return JSON.stringify(JSON.parse(schema), null, 2);
  } catch {
    return schema;
  }
}
