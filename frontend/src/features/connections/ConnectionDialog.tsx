import { useRef, useState } from "react";
import { CheckCircle2, FolderOpen, PlugZap } from "lucide-react";
import { connectionsApi, friendlyError, systemApi } from "../../shared/api.js";
import { useConnections } from "../../state/stores.js";
import { useWorkspace } from "../../state/workspace.js";
import { t } from "../../shared/i18n.js";
import type { Connection, TestResult } from "../../shared/contracts.js";
import { Modal } from "../common/Modal.js";
import { ErrorHint } from "../common/ErrorHint.js";
import { confirmDialog } from "../common/ConfirmDialog.js";
import { Select, Switch } from "../common/controls.js";
import { useToast } from "../../state/stores.js";

// CertPathField: one certificate path with an inline 浏览 button — paths
// are unreadable to type by hand and the dialog guarantees a real file.
function CertPathField({
  label,
  value,
  onChange,
  onBrowse,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onBrowse: () => Promise<void> | void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-11 text-ink-300">{label}</span>
      <div className="flex items-center gap-1.5">
        <input className="field flex-1 font-mono" value={value} onChange={(e) => onChange(e.target.value)} />
        <button className="btn !px-2 flex-none" title={t("conn.pickCert")} onClick={() => void onBrowse()}>
          <FolderOpen size={13} />
        </button>
      </div>
    </label>
  );
}

const MECHANISMS = [
  { value: "none", label: "None (PLAINTEXT)" },
  { value: "sasl/plain", label: "SASL / PLAIN" },
  { value: "sasl/scram-sha256", label: "SASL / SCRAM-SHA-256" },
  { value: "sasl/scram-sha512", label: "SASL / SCRAM-SHA-512" },
];

interface Props {
  connectionId?: string; // undefined = create
  onClose: () => void;
}

export function ConnectionDialog({ connectionId, onClose }: Props) {
  const refresh = useConnections((s) => s.refresh);
  const toast = useToast();
  const list = useConnections((s) => s.list);
  const existing = connectionId ? list.find((c) => c.id === connectionId) : undefined;

  const [name, setName] = useState(existing?.name ?? "");
  const [bootstrap, setBootstrap] = useState(existing?.bootstrap ?? "");
  const [security, setSecurity] = useState(existing?.security ?? "none");
  const [username, setUsername] = useState(existing?.username ?? "");
  const [password, setPassword] = useState("");
  const [tlsEnabled, setTlsEnabled] = useState(existing?.tls?.enabled ?? false);
  const [caCert, setCaCert] = useState(existing?.tls?.caCertPath ?? "");
  const [clientCert, setClientCert] = useState(existing?.tls?.clientCertPath ?? "");
  const [clientKey, setClientKey] = useState(existing?.tls?.clientKeyPath ?? "");
  const [insecure, setInsecure] = useState(existing?.tls?.insecureSkipVerify ?? false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [saveError, setSaveError] = useState<unknown>(null);
  const needsPassword = security !== "none";
  const isLive = connectionId != null && useWorkspace.getState().tabs.some((t) => t.connectionId === connectionId);
  // Stale results lie once the form changes (the tested address may no
  // longer be what is in the box), so any edit clears both panels.
  const clearFeedback = () => {
    setSaveError(null);
    setTestResult(null);
  };
  const onName = (v: string) => { clearFeedback(); setName(v); };
  const onBootstrap = (v: string) => { clearFeedback(); setBootstrap(v); };
  const onSecurity = (v: string) => { clearFeedback(); setSecurity(v); };
  const onUsername = (v: string) => { clearFeedback(); setUsername(v); };
  const onPassword = (v: string) => { clearFeedback(); setPassword(v); };
  const onTls = (v: boolean) => { clearFeedback(); setTlsEnabled(v); };
  const onCaCert = (v: string) => { clearFeedback(); setCaCert(v); };
  const onClientCert = (v: string) => { clearFeedback(); setClientCert(v); };
  const onClientKey = (v: string) => { clearFeedback(); setClientKey(v); };
  const onInsecure = (v: boolean) => { clearFeedback(); setInsecure(v); };
  // Native open dialog for certificate paths; picking a file is a form edit
  // and must clear the stale test/save feedback like every other change.
  const browse = (setter: (v: string) => void) => async () => {
    try {
      const path = await systemApi.pickOpenFile(t("conn.pickCert"), "*.pem;*.crt;*.cer;*.key;*.p12;*.jks");
      if (path) setter(path);
    } catch (err) {
      toast.show(friendlyError(err), "error");
    }
  };
  // Modal owns the exit animation; async handlers close through this ref so
  // save/delete also play the sink-out instead of vanishing instantly.
  const closeRef = useRef<() => void>(() => {});

  // Entries without a port dial :9092 in franz-go, so normalize before
  // Validate — otherwise Test succeeds (default port) while Save rejects
  // the same input as "not host:port".
  const normalizeBootstrap = (raw: string): string =>
    raw
      .split(",")
      .map((e) => {
        const entry = e.trim();
        if (!entry) return entry;
        if (!entry.includes(":")) return `${entry}:9092`;
        return entry;
      })
      .join(",");

  const buildConnection = (): Connection => ({
    id: existing?.id ?? "",
    name,
    bootstrap: normalizeBootstrap(bootstrap),
    security,
    username: needsPassword ? username : undefined,
    secretRef: existing?.secretRef,
    tls: {
      enabled: tlsEnabled,
      caCertPath: caCert || undefined,
      clientCertPath: clientCert || undefined,
      clientKeyPath: clientKey || undefined,
      insecureSkipVerify: insecure || undefined,
    },
    // Omit when absent: a new connection has no timestamps yet. (Go's
    // FlexTime tolerates "", but an absent field is the honest wire shape.)
    createdAt: existing?.createdAt || undefined,
    updatedAt: existing?.updatedAt || undefined,
  });

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await connectionsApi.save({ connection: buildConnection(), password: password || undefined });
      await refresh();
      toast.show(t("conn.saved"), "ok");
      closeRef.current();
    } catch (err) {
      setSaveError(err); // friendly panel below the form, hints per error class
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      // Test uses what is in the form: if the user did not retype a password,
      // persist-first is the only way to test with the stored one.
      const result = await connectionsApi.test(buildConnection(), password || undefined);
      setTestResult(result);
    } catch (err) {
      setTestResult({ success: false, error: String(err), elapsedMs: 0 });
    } finally {
      setTesting(false);
    }
  };

  const remove = async () => {
    if (!existing) return;
    if (!(await confirmDialog({ message: t("conn.deleteConfirm", existing.name), danger: true }))) return;
    await connectionsApi.remove(existing.id);
    await refresh();
    // The connection is gone: its tab (if any) must go with it.
    useWorkspace.getState().pruneTabs(useConnections.getState().list.map((c) => c.id));
    closeRef.current();
  };

  return (
    <Modal
      title={existing ? existing.name : t("sidebar.addConnection")}
      width={460}
      onClose={onClose}
    >
      {(close) => {
        closeRef.current = close;
        return (
          <>
            <div className="space-y-2.5">
          <label className="block">
            <span className="mb-1 block text-11 text-ink-300">{t("conn.name")}</span>
            <input className="field" value={name} onChange={(e) => onName(e.target.value)} />
          </label>
          <label className="block">
            <span className="mb-1 block text-11 text-ink-300">{t("conn.bootstrap")}</span>
            <input
              className="field font-mono"
              placeholder={t("conn.bootstrapHint")}
              value={bootstrap}
              onChange={(e) => onBootstrap(e.target.value)}
            />
          </label>
          <div className="grid grid-cols-2 gap-2.5">
            <label className="block">
              <span className="mb-1 block text-11 text-ink-300">{t("conn.security")}</span>
                  <Select className="w-full" value={security} options={MECHANISMS.map((m) => ({ value: m.value, label: m.label }))} onChange={(v) => onSecurity(v)} />
            </label>
            {needsPassword && (
              <label className="block">
                <span className="mb-1 block text-11 text-ink-300">{t("conn.username")}</span>
                <input className="field" value={username} onChange={(e) => onUsername(e.target.value)} />
              </label>
            )}
          </div>
          {needsPassword && (
            <label className="block">
              <span className="mb-1 block text-11 text-ink-300">
                {t("conn.password")}
                {existing?.secretRef && <span className="ml-1 text-ink-400">（{t("conn.passwordKeep")}）</span>}
              </span>
              <input
                className="field"
                type="password"
                value={password}
                onChange={(e) => onPassword(e.target.value)}
              />
            </label>
          )}
          <div className="flex items-center gap-2 pt-1 text-xs">
            <Switch checked={tlsEnabled} onChange={(v) => onTls(v)} />
            {t("conn.tls")}
          </div>
          {isLive && (
            <div className="rounded border border-warn/40 bg-warn/10 px-2 py-1.5 text-10 leading-relaxed text-warn">
              {t("conn.saveReconnectHint")}
            </div>
          )}
          {tlsEnabled && (
            <div className="space-y-2.5 rounded border border-ink-700 bg-ink-900 p-2.5">
              <CertPathField label={t("conn.tlsCa")} value={caCert} onChange={onCaCert} onBrowse={browse(setCaCert)} />
              <CertPathField label={t("conn.tlsClientCert")} value={clientCert} onChange={onClientCert} onBrowse={browse(setClientCert)} />
              <CertPathField label={t("conn.tlsClientKey")} value={clientKey} onChange={onClientKey} onBrowse={browse(setClientKey)} />
              <div className="flex items-center gap-2 text-xs">
                <Switch checked={insecure} onChange={(v) => onInsecure(v)} />
                {t("conn.tlsInsecure")}
              </div>
            </div>
          )}

          {testResult && (
            testResult.success ? (
              <div className="rounded border border-ok/40 bg-ok/10 px-3 py-2.5 selectable">
                <div className="flex items-center gap-1.5 text-xs font-medium text-ok">
                  <CheckCircle2 size={14} />
                  {t("conn.testOkTitle")}
                  <span className="rounded bg-ok/15 px-1.5 py-0.5 font-mono text-10 font-normal text-ink-200">
                    {t("conn.testOkMs", testResult.elapsedMs)}
                  </span>
                </div>
                {(testResult.brokers ?? []).length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {(testResult.brokers ?? []).map((b) => (
                      <span key={b} className="rounded bg-ink-850 px-1.5 py-0.5 font-mono text-10 text-ink-200">
                        {b}
                      </span>
                    ))}
                  </div>
                )}
                <div className="mt-1.5 text-10 text-ink-400">{t("conn.testOkNote")}</div>
              </div>
            ) : (
              <ErrorHint error={testResult.error} />
            )
          )}
          {saveError !== null && <ErrorHint error={saveError} />}
        </div>
          <div className="mt-3 flex items-center gap-2 border-t border-ink-700 pt-3">
            {existing && (
              <button className="btn btn-danger" onClick={() => void remove()}>
                {t("conn.delete")}
              </button>
            )}
            <div className="flex-1" />
            <button className="btn" disabled={testing} onClick={() => void test()}>
              <PlugZap size={13} /> {testing ? t("conn.testing") : t("conn.test")}
            </button>
            <button className="btn" onClick={close}>
              {t("conn.cancel")}
            </button>
            <button className="btn btn-accent" disabled={saving} onClick={() => void save()}>
              {t("conn.save")}
            </button>
          </div>
          </>
        );
      }}
    </Modal>
  );
}

// CloneDialog: asks for the clone's name BEFORE anything is created — the
// old flow cloned immediately and only then opened the editor, so clicking
// cancel there left the clone behind. Cancel here means nothing happened.
export function CloneDialog({
  source,
  onClose,
  onCloned,
}: {
  source: Connection;
  onClose: () => void;
  onCloned: (clone: Connection) => void;
}) {
  const [name, setName] = useState(source.name + t("conn.cloneSuffix"));
  const refresh = useConnections((s) => s.refresh);
  const toast = { show: useToast((s) => s.show) };
  const [cloning, setCloning] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const run = async () => {
    if (!name.trim()) return;
    setCloning(true);
    setError(null);
    try {
      const clone = await connectionsApi.clone(source.id, name.trim());
      await refresh();
      toast.show(t("conn.cloneOk", clone.name), "ok");
      onCloned(clone);
    } catch (err) {
      setError(err);
    } finally {
      setCloning(false);
    }
  };

  return (
    <Modal title={t("conn.clone")} width={420} onClose={onClose}>
      {(close) => (
        <div className="space-y-2.5">
          <div className="text-11 leading-relaxed text-ink-300">{t("conn.cloneHint", source.name)}</div>
          <label className="block">
            <span className="mb-1 block text-11 text-ink-300">{t("conn.name")}</span>
            <input
              className="field"
              value={name}
              autoFocus
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => e.key === "Enter" && void run()}
            />
          </label>
          {error !== null && <ErrorHint error={error} />}
          <div className="mt-3 flex items-center gap-2 border-t border-ink-700 pt-3">
            <div className="flex-1" />
            <button className="btn" onClick={close}>
              {t("conn.cancel")}
            </button>
            <button className="btn btn-accent" disabled={cloning || !name.trim()} onClick={() => void run()}>
              {t("conn.clone")}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
