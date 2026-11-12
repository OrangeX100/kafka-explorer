import { useEffect, useState } from "react";
import { PlugZap } from "lucide-react";
import { Modal } from "../common/Modal.js";
import { Select } from "../common/controls.js";
import { connectionsApi, registryApi, systemApi } from "../../shared/api.js";
import { friendlyError } from "../../shared/api.js";
import { useToast } from "../../state/stores.js";
import { t } from "../../shared/i18n.js";
import type { Connection } from "../../shared/contracts.js";
import type { LocalSchema, SchemaRegistry } from "../../shared/contracts-admin.js";

// RegistryDialog: create AND edit a registry connection. In edit mode the
// password field stays empty (the stored secret is kept unless the user
// types a replacement) — write-only like the SASL connection form. The
// cluster binding picks WHICH connection decodes through this registry.
export function RegistryDialog({
  existing,
  onClose,
  onSaved,
}: {
  existing?: SchemaRegistry | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(existing?.name ?? "");
  const [url, setUrl] = useState(existing?.url ?? "");
  const [username, setUsername] = useState(existing?.username ?? "");
  const [password, setPassword] = useState("");
  const [connectionId, setConnectionId] = useState(existing?.connectionId ?? "");
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const toast = { show: useToast((s) => s.show) };

  useEffect(() => {
    connectionsApi.list().then((c) => setConnections(c ?? [])).catch(() => setConnections([]));
  }, []);

  const form = (): SchemaRegistry => ({
    id: existing?.id ?? "",
    name: name.trim(),
    url: url.trim(),
    username: username.trim() || undefined,
    connectionId: connectionId || undefined,
  });

  const save = async () => {
    try {
      await registryApi.save({ registry: form(), password: password || undefined });
      toast.show(t("reg.registrySaved"), "ok");
      onSaved();
    } catch (err) {
      setResult({ ok: false, text: friendlyError(err) });
    }
  };

  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      const version = await registryApi.test(form(), password || undefined);
      setResult({ ok: true, text: t("reg.testOk", version) });
    } catch (err) {
      setResult({ ok: false, text: friendlyError(err) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <Modal title={existing ? t("reg.editRegistry") : t("sidebar.addRegistry")} width={440} onClose={onClose}>
      {(close) => (
        <div className="space-y-2.5">
          <label className="block">
            <span className="mb-1 block text-11 text-ink-300">{t("reg.name")}</span>
            <input className="field" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="block">
            <span className="mb-1 block text-11 text-ink-300">{t("reg.url")}</span>
            <input className="field font-mono" placeholder={t("reg.urlHint")} value={url} onChange={(e) => setUrl(e.target.value)} />
          </label>
          <div className="grid grid-cols-2 gap-2.5">
            <label className="block">
              <span className="mb-1 block text-11 text-ink-300">{t("reg.username")}</span>
              <input className="field" value={username} onChange={(e) => setUsername(e.target.value)} />
            </label>
            <label className="block">
              <span className="mb-1 block text-11 text-ink-300">{t("reg.password")}</span>
              <input
                className="field"
                type="password"
                placeholder={existing ? t("reg.passwordKeep") : undefined}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
          </div>
          <label className="block">
            <span className="mb-1 block text-11 text-ink-300">{t("reg.bindConnection")}</span>
            <div className="min-h-[26px]">
              <Select
                value={connectionId}
                options={[
                  { value: "", label: t("reg.bindNone") },
                  ...(connections ?? []).map((c) => ({ value: c.id, label: c.name })),
                ]}
                onChange={(v) => setConnectionId(v)}
              />
            </div>
            <span className="mt-1 block text-10 text-ink-400">{t("reg.bindHint")}</span>
          </label>
          {result && (
            <div
              className={`rounded border px-2.5 py-2 text-11 selectable ${
                result.ok ? "border-ok/40 bg-ok/10 text-ink-100" : "border-danger/40 bg-danger/10 text-ink-100"
              }`}
            >
              {result.text}
            </div>
          )}
          <div className="mt-3 flex items-center gap-2 border-t border-ink-700 pt-3">
            <button className="btn" disabled={testing} onClick={() => void test()}>
              <PlugZap size={13} /> {testing ? t("conn.testing") : t("reg.test")}
            </button>
            <div className="flex-1" />
            <button className="btn" onClick={close}>
              {t("conn.cancel")}
            </button>
            <button className="btn btn-accent" disabled={!name.trim() || !url.trim()} onClick={() => void save()}>
              {t("conn.save")}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// LocalSchemaDialog: create or edit one offline schema. Type stays a fixed
// picker; Avro is the only type the offline decoder handles today, and the
// dialog says so instead of letting PROTOBUF selections silently fail.
export function LocalSchemaDialog({
  existing,
  onClose,
  onSaved,
}: {
  existing?: LocalSchema | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(existing?.name ?? "");
  const [schemaType, setSchemaType] = useState(existing?.schemaType ?? "AVRO");
  const [schema, setSchema] = useState(existing?.schema ?? "");
  const toast = { show: useToast((s) => s.show) };

  const save = async () => {
    try {
      await registryApi.saveLocal({
        id: existing?.id ?? "",
        name: name.trim(),
        schemaType,
        schema,
      });
      toast.show(t("reg.localSaved"), "ok");
      onSaved();
    } catch (err) {
      toast.show(friendlyError(err), "error");
    }
  };

  return (
    <Modal title={existing ? t("reg.localEdit") : t("reg.localAdd")} width={560} onClose={onClose}>
      {(close) => (
        <div className="space-y-2.5">
          <div className="grid grid-cols-2 gap-2.5">
            <label className="block">
              <span className="mb-1 block text-11 text-ink-300">{t("reg.localName")}</span>
              <input className="field" value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="block">
              <span className="mb-1 block text-11 text-ink-300">{t("reg.localType")}</span>
              <div className="min-h-[26px]">
                <Select
                  value={schemaType}
                  options={[
                    { value: "AVRO", label: "Avro" },
                    { value: "JSON", label: "JSON Schema" },
                    { value: "PROTOBUF", label: "Protobuf" },
                  ]}
                  onChange={(v) => setSchemaType(v)}
                />
              </div>
            </label>
          </div>
          <p className="rounded bg-ink-800 border border-ink-700 px-2.5 py-1.5 text-11 text-ink-200">
            {t("reg.localAllTypes")}
          </p>
          <label className="block">
            <span className="mb-1 block text-11 text-ink-300">{t("reg.localSchema")}</span>
            <textarea
              className="field font-mono"
              rows={14}
              spellCheck={false}
              value={schema}
              onChange={(e) => setSchema(e.target.value)}
              placeholder={'{"type":"record","name":"User","fields":[{"name":"id","type":"int"}]}'}
            />
          </label>
          <div className="mt-3 flex items-center gap-2 border-t border-ink-700 pt-3">
            <div className="flex-1" />
            <button className="btn" onClick={close}>
              {t("conn.cancel")}
            </button>
            <button className="btn btn-accent" disabled={!name.trim() || !schema.trim()} onClick={() => void save()}>
              {t("conn.save")}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// SchemaRegisterModal: register a NEW subject or a NEW version on an
// existing one. Pipeline mirrors the decoder's acceptance rules: local
// precheck (same parse path as decoding, zero registry round trip) →
// compatibility check vs latest (existing subjects) → register. The result
// reports the assigned schema id + subject version.
export function SchemaRegisterModal({
  registryId,
  subjects,
  initialSubject,
  onClose,
  onRegistered,
}: {
  registryId: string;
  subjects: string[];
  // Pre-fill from the selected subject rail row ("new version on it").
  initialSubject?: string;
  onClose: () => void;
  onRegistered: (subject: string) => void;
}) {
  const existing = subjects.includes(initialSubject ?? "");
  const [mode, setMode] = useState<"existing" | "new">(existing ? "existing" : "new");
  const [subject, setSubject] = useState(initialSubject ?? "");
  const [schemaType, setSchemaType] = useState("AVRO");
  const [schema, setSchema] = useState("");
  const [check, setCheck] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = { show: useToast((s) => s.show) };

  // Load-from-file reads the file the user just picked; the path comes
  // from the native dialog, the content from the backend text reader.
  const loadFile = async () => {
    const path = await systemApi.pickOpenFile(t("reg.registerLoadFile"), ".avsc,.json,.proto,.txt");
    if (!path) return;
    try {
      setSchema(await systemApi.readTextFile(path));
    } catch (err) {
      toast.show(friendlyError(err), "error");
    }
  };

  const precheck = async () => {
    setCheck(null);
    setBusy(true);
    try {
      await registryApi.validateSchema(schemaType, schema);
      setCheck({ ok: true, text: t("reg.precheckOk") });
    } catch (err) {
      setCheck({ ok: false, text: friendlyError(err) });
    } finally {
      setBusy(false);
    }
  };

  const compat = async () => {
    setCheck(null);
    setBusy(true);
    try {
      const res = await registryApi.compatibility(registryId, subject, schema, schemaType);
      setCheck({
        ok: res.isCompatible,
        text: res.isCompatible ? t("reg.compatOk") : `${t("reg.compatFail")} ${res.messages?.join("；") ?? ""}`,
      });
    } catch (err) {
      setCheck({ ok: false, text: friendlyError(err) });
    } finally {
      setBusy(false);
    }
  };

  const register = async () => {
    setBusy(true);
    try {
      const res = await registryApi.registerSchema(registryId, subject.trim(), schema, schemaType);
      toast.show(t("reg.registerOk", String(res.id), String(res.version)), "ok");
      onRegistered(subject.trim());
    } catch (err) {
      setCheck({ ok: false, text: friendlyError(err) });
    } finally {
      setBusy(false);
    }
  };

  const subjectOk = mode === "existing" ? subject !== "" : subject.trim() !== "";
  return (
    <Modal title={t("reg.registerTitle")} width={560} onClose={onClose}>
      {(close) => (
        <div className="space-y-2.5">
          <div className="flex items-center gap-2">
            <div className="w-56">
              <Select
                value={mode}
                options={[
                  { value: "new", label: t("reg.registerNewSubject") },
                  { value: "existing", label: t("reg.registerExistingSubject") },
                ]}
                onChange={(v) => {
                  setMode(v as "existing" | "new");
                  setSubject(v === "existing" ? initialSubject ?? subjects[0] ?? "" : "");
                }}
              />
            </div>
            {mode === "existing" ? (
              <div className="min-w-0 flex-1">
                <Select value={subject} options={subjects.map((s) => ({ value: s, label: s }))} onChange={setSubject} />
              </div>
            ) : (
              <input
                className="field min-w-0 flex-1 font-mono"
                placeholder="my-topic-value"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
              />
            )}
          </div>
          <div className="grid grid-cols-[130px_1fr_auto] items-end gap-2.5">
            <label className="block">
              <span className="mb-1 block text-11 text-ink-300">{t("reg.localType")}</span>
              <Select
                value={schemaType}
                options={[
                  { value: "AVRO", label: "Avro" },
                  { value: "JSON", label: "JSON Schema" },
                  { value: "PROTOBUF", label: "Protobuf" },
                ]}
                onChange={(v) => setSchemaType(v)}
              />
            </label>
            <div className="flex-1" />
            <button className="btn" onClick={() => void loadFile()}>{t("reg.registerLoadFile")}</button>
          </div>
          <label className="block">
            <span className="mb-1 block text-11 text-ink-300">{t("reg.localSchema")}</span>
            <textarea
              className="field h-44 resize-y font-mono text-11"
              value={schema}
              onChange={(e) => setSchema(e.target.value)}
              spellCheck={false}
              placeholder={schemaType === "PROTOBUF" ? 'syntax = "proto3";\nmessage Event { int64 id = 1; }' : '{"type":"record","name":"User","fields":[{"name":"id","type":"int"}]}'}
            />
          </label>
          {check && (
            <div
              className={`rounded border px-2.5 py-2 text-11 selectable whitespace-pre-wrap ${
                check.ok ? "border-ok/40 bg-ok/10 text-ink-100" : "border-danger/40 bg-danger/10 text-ink-100"
              }`}
            >
              {check.text}
            </div>
          )}
          <div className="flex items-center gap-2">
            <button className="btn" disabled={!schema.trim() || busy} onClick={() => void precheck()}>
              {t("reg.precheck")}
            </button>
            <button
              className="btn"
              disabled={!schema.trim() || subjectOk === false || busy}
              onClick={() => void compat()}
              title={t("reg.precheckHint")}
            >
              {t("reg.checkCompat")}
            </button>
            <div className="flex-1" />
            <button className="btn" onClick={close}>{t("conn.cancel")}</button>
            <button className="btn btn-accent" disabled={!subjectOk || !schema.trim() || busy} onClick={() => void register()}>
              {t("reg.registerSubmit")}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
