import { useCallback, useEffect, useState } from "react";
import {  Copy, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { adminApi, friendlyError } from "../../shared/api.js";
import { useToast } from "../../state/stores.js";
import { t } from "../../shared/i18n.js";
import { confirmDialog } from "../common/ConfirmDialog.js";
import { useContextMenu } from "../common/ContextMenu.js";
import { useCopy } from "../../shared/useCopy.js";
import { SkeletonLines } from "../common/Skeleton.js";
import { EmptyState } from "../common/EmptyState.js";
import { Modal } from "../common/Modal.js";
import type { ACL } from "../../shared/contracts-admin.js";
import { ErrorHint } from "../common/ErrorHint.js";
import { Select } from "../common/controls.js";

const OPERATIONS = ["ANY", "ALL", "READ", "WRITE", "CREATE", "DELETE", "ALTER", "DESCRIBE", "DESCRIBE_CONFIGS", "ALTER_CONFIGS", "CLUSTER_ACTION", "IDEMPOTENT_WRITE"];
const RESOURCES = ["TOPIC", "GROUP", "CLUSTER", "TRANSACTIONAL_ID", "USER", "DELEGATION_TOKEN"];
const PATTERNS = ["LITERAL", "PREFIXED"];

// ACLsView: read + create + delete ACLs (the classic ACL panel).
export function ACLsView({ connectionId }: { connectionId: string }) {
  const [acls, setAcls] = useState<ACL[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [authDisabled, setAuthDisabled] = useState(false);
  const [creating, setCreating] = useState(false);
  const toast = useToast();

  const load = useCallback(async () => {
    setAcls(null);
    setLoadError(null);
    setAuthDisabled(false);
    try {
      setAcls((await adminApi.listACLs(connectionId)) ?? []);
    } catch (err) {
      const msg = String(err);
      // An un-authorized cluster (no SASL/ACL config) is a *state*, not an
      // error worth a red toast on every tab switch.
      if (/CLUSTER_AUTHORIZATION_FAILED|SECURITY_DISABLED|SecurityDisabled|UNSUPPORTED_VERSION|not authorized|No Authorizer/i.test(msg)) {
        setAuthDisabled(true);
        setAcls([]);
        return;
      }
      setLoadError(err);
      setAcls([]);
    }
  }, [connectionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const { open: openCtx, menu: ctxMenu } = useContextMenu();
  const copy = useCopy();
  const remove = async (acl: ACL) => {
    // Deleting an ACL silently revokes someone's access — always confirm.
    if (
      !(await confirmDialog({
        message: t("acls.deleteConfirm", acl.principal, acl.resourceType + ":" + acl.resourceName),
        danger: true,
      }))
    )
      return;
    try {
      await adminApi.deleteACL(connectionId, acl);
      toast.show(t("acls.deleted"), "ok");
      await load();
    } catch (err) {
      toast.show(friendlyError(err), "error");
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1.5 border-b border-ink-700 bg-ink-900 px-2 py-1.5">
        <button className="btn btn-accent" onClick={() => setCreating(true)}>
          <Plus size={13} /> {t("acls.create")}
        </button>
        <div className="flex-1" />
        <button className="btn" onClick={() => void load()}>↻</button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {acls === null && (
          <div className="p-3">
            <SkeletonLines rows={5} />
          </div>
        )}
        {authDisabled && (
          <EmptyState
            icon={<ShieldCheck size={20} />}
            title={t("acls.notEnabledTitle")}
            desc={t("acls.notEnabled")}
          />
        )}
        {!authDisabled && loadError !== null && (
          <div className="w-full max-w-xl px-6 py-6">
            <ErrorHint error={loadError} onRetry={() => void load()} />
          </div>
        )}
        {!authDisabled && !loadError && acls !== null && acls.length === 0 && (
          <EmptyState icon={<ShieldCheck size={20} />} title={t("ws.acls")} desc={t("acls.emptyDesc")} steps={t("acls.emptySteps").split("|")} />
        )}
        {(acls ?? []).map((a, i) => (
          <div
            key={`${a.principal}-${a.resourceType}-${a.resourceName}-${a.operation}-${i}`}
            className="group flex items-center gap-3 border-b border-ink-800 px-3 py-1.5 text-xs hover:bg-ink-850"
            onContextMenu={(e) =>
              openCtx(e, [
                { label: t("ctx.copyPrincipal"), icon: <Copy size={13} />, onSelect: () => copy(a.principal) },
                {
                  label: t("ctx.copyResource"),
                  icon: <Copy size={13} />,
                  onSelect: () => copy(`${a.resourceType}:${a.resourceName} (${a.patternType})`),
                },
                { label: t("ctx.copyOperation"), icon: <Copy size={13} />, onSelect: () => copy(`${a.permissionType} ${a.operation}`) },
                {
                  label: t("acls.delete"),
                  icon: <Trash2 size={13} />,
                  danger: true,
                  separatorBefore: true,
                  onSelect: () => void remove(a),
                },
              ])
            }
          >
            <span className="w-44 truncate font-mono text-accent" title={a.principal}>
              {a.principal}
            </span>
            <span
              className="rounded bg-ink-800 px-1.5 py-0.5 text-10 text-ink-300"
              title={`${t(`acls.resDesc.${a.resourceType}`)} · ${t(`acls.patDesc.${a.patternType}`)}`}
            >
              {a.resourceType}:{a.resourceName} ({a.patternType})
            </span>
            <span
              className="text-ink-200"
              title={`${a.permissionType} — ${t(`acls.permDesc.${a.permissionType}`)} · ${a.operation} — ${t(`acls.opDesc.${a.operation}`)}`}
            >
              {a.permissionType === "ALLOW" ? "✓" : "✕"} {a.operation}
            </span>
            <span className="flex-1" />
            <button
              className="btn !px-2 !py-0.5 text-10 opacity-70 hover:!text-danger group-hover:opacity-100"
              title={t("acls.delete")}
              onClick={() => void remove(a)}
            >
              <Trash2 size={11} /> {t("acls.delete")}
            </button>
          </div>
        ))}
      </div>

      {ctxMenu}
      {creating && (
        <CreateACLDialog
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

function CreateACLDialog({
  connectionId,
  onClose,
  onCreated,
}: {
  connectionId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [principal, setPrincipal] = useState("User:");
  const [operation, setOperation] = useState("READ");
  const [permissionType, setPermissionType] = useState("ALLOW");
  const [resourceType, setResourceType] = useState("TOPIC");
  const [resourceName, setResourceName] = useState("");
  const [patternType, setPatternType] = useState("LITERAL");
  const [host, setHost] = useState("*");
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const closeRef = { current: onClose };

  const create = async () => {
    setBusy(true);
    try {
      await adminApi.createACL(connectionId, {
        principal, operation, permissionType, resourceType, resourceName, patternType, host,
      });
      toast.show(`${principal} → ${resourceType}:${resourceName}`, "ok");
      onCreated();
    } catch (err) {
      toast.show(friendlyError(err), "error");
    } finally {
      setBusy(false);
    }
  };

  // Field with an option-aware explanation: the select keeps the English
  // enum values (what Kafka and kafka-acls.sh expect), while a caption
  // below explains the CURRENTLY SELECTED value in Chinese.
  function Field({
    label,
    desc,
    children,
  }: {
    label: string;
    desc: string;
    children: React.ReactNode;
  }) {
    return (
      <label className="block">
        <span className="mb-1 block text-11 text-ink-300">{label}</span>
        {children}
        <span className="mt-1 block text-10 leading-relaxed text-ink-400">{desc}</span>
      </label>
    );
  }

  return (
    <Modal title={t("acls.create")} width={520} onClose={onClose}>
      {(close) => {
        closeRef.current = close;
        return (
          <div className="space-y-2.5">
            <p className="rounded border border-ink-700 bg-ink-900 px-2.5 py-2 text-11 leading-relaxed text-ink-300">
              {t("acls.intro")}
            </p>
            <Field label={t("acls.colPrincipal")} desc={t("acls.fieldDesc.principal")}>
              <input className="field font-mono" value={principal} onChange={(e) => setPrincipal(e.target.value)} />
            </Field>
            <div className="grid grid-cols-2 gap-2.5">
              <Field label={t("acls.colOp")} desc={t(`acls.opDesc.${operation}`)}>
                                <Select value={operation} options={OPERATIONS.map((o) => ({ value: o, label: o }))} onChange={(v) => setOperation(v)} />
              </Field>
              <Field label={t("acls.colPerm")} desc={t(`acls.permDesc.${permissionType}`)}>
                                <Select value={permissionType} options={[{ value: "ALLOW", label: "ALLOW" }, { value: "DENY", label: "DENY" }]} onChange={(v) => setPermissionType(v)} />
              </Field>
              <Field label={t("acls.colResource")} desc={t(`acls.resDesc.${resourceType}`)}>
                                <Select value={resourceType} options={RESOURCES.map((r) => ({ value: r, label: r }))} onChange={(v) => setResourceType(v)} />
              </Field>
              <Field label={t("acls.colPattern")} desc={t(`acls.patDesc.${patternType}`)}>
                                <Select value={patternType} options={PATTERNS.map((pt) => ({ value: pt, label: pt }))} onChange={(v) => setPatternType(v)} />
              </Field>
            </div>
            <Field label={t("acls.colResourceName")} desc={t("acls.fieldDesc.resourceName")}>
              <input className="field font-mono" value={resourceName} onChange={(e) => setResourceName(e.target.value)} />
            </Field>
            <Field label={t("acls.colHost")} desc={t("acls.fieldDesc.host")}>
              <input className="field font-mono" value={host} onChange={(e) => setHost(e.target.value)} />
            </Field>
            <div className="mt-3 flex justify-end gap-2 border-t border-ink-700 pt-3">
              <button className="btn" onClick={close}>
                {t("conn.cancel")}
              </button>
              <button className="btn btn-accent" disabled={busy || !resourceName || !principal} onClick={() => void create()}>
                {t("conn.save")}
              </button>
            </div>
          </div>
        );
      }}
    </Modal>
  );
}
