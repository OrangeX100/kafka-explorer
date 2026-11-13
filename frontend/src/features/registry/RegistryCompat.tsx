import { useEffect, useState } from "react";
import { CheckCircle2, XCircle } from "lucide-react";
import { Select } from "../common/controls.js";
import { registryApi, friendlyError } from "../../shared/api.js";
import { useToast } from "../../state/stores.js";
import { t } from "../../shared/i18n.js";
import type { CompatibilityCheck, SchemaSubject, SchemaVersion } from "../../shared/contracts-admin.js";

// Compatibility workbench: the candidate editor posts against a chosen
// anchor version, and the subject's compatibility level is adjustable in
// place. The level shown here is LOCAL state seeded from the registry (the
// subject prop's compatibility is a list snapshot that goes stale after an
// in-place change — selecting a level used to "snap back" to the stale
// value while the registry had actually stored it).
const COMPAT_LEVELS = [
  "BACKWARD",
  "BACKWARD_TRANSITIVE",
  "FORWARD",
  "FORWARD_TRANSITIVE",
  "FULL",
  "FULL_TRANSITIVE",
  "NONE",
] as const;

// One-line semantics per level — rendered under the select so the choice
// is self-explaining (option labels keep the registry terminology).
const LEVEL_DESC: Record<string, string> = {
  BACKWARD: "reg.levelBackward",
  BACKWARD_TRANSITIVE: "reg.levelBackwardT",
  FORWARD: "reg.levelForward",
  FORWARD_TRANSITIVE: "reg.levelForwardT",
  FULL: "reg.levelFull",
  FULL_TRANSITIVE: "reg.levelFullT",
  NONE: "reg.levelNone",
};

export function CompatTab({
  registryId,
  subject,
  versions,
}: {
  registryId: string;
  subject: SchemaSubject;
  versions: SchemaVersion[] | null;
}) {
  const latest = versions?.find((v) => v.version === subject.version);
  const [candidate, setCandidate] = useState(() => prettySchema(subject.schema));
  const [checkAnchor, setCheckAnchor] = useState<string>("latest");
  const [check, setCheck] = useState<CompatibilityCheck | null>(null);
  const [busy, setBusy] = useState(false);
  // The level is read from the registry itself: the subject list snapshot
  // may be stale ("" = no override → the registry default applies).
  const [level, setLevelState] = useState<string>("NONE");
  const toast = { show: useToast((s) => s.show) };

  useEffect(() => {
    let alive = true;
    registryApi
      .subjectConfig(registryId, subject.name)
      .then((cfg) => {
        if (alive) setLevelState(cfg || "NONE");
      })
      .catch(() => {
        if (alive) setLevelState(subject.compatibility || "NONE");
      });
    return () => {
      alive = false;
    };
  }, [registryId, subject.name, subject.compatibility]);

  const anchorOptions = [
    { value: "latest", label: t("reg.checkAgainstLatest") },
    ...(versions ?? []).map((v) => ({ value: String(v.version), label: `${t("reg.colVersion")} ${v.version}` })),
  ];

  const runCheck = async () => {
    setBusy(true);
    setCheck(null);
    try {
      const anchor = checkAnchor === "latest" ? 0 : Number(checkAnchor);
      setCheck(await registryApi.compatibilityVersion(registryId, subject.name, anchor, candidate, subject.schemaType));
    } catch (err) {
      toast.show(friendlyError(err), "error");
    } finally {
      setBusy(false);
    }
  };

  const setLevel = async (level: string) => {
    const prev = level;
    try {
      await registryApi.setSubjectConfig(registryId, subject.name, level);
      setLevelState(level); // optimistic: the registry confirmed the write
      toast.show(t("reg.configSaved"), "ok");
    } catch (err) {
      setLevelState(prev); // keep the registry's last known value
      toast.show(friendlyError(err), "error");
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-3">
      <div className="flex flex-wrap items-center gap-2 text-11 text-ink-300">
        <span>{t("reg.compatLevel")}</span>
        <div className="w-64">
          <Select
            value={level}
            options={COMPAT_LEVELS.map((l) => ({ value: l, label: `${l} · ${t(LEVEL_DESC[l])}` }))}
            onChange={(v) => void setLevel(v)}
          />
        </div>
        <span className="text-10 text-ink-400">{t((LEVEL_DESC[level] ?? "reg.levelNone") + "_long")}</span>
        <div className="flex-1" />
        <div className="w-40">
          <Select value={checkAnchor} options={anchorOptions} onChange={setCheckAnchor} />
        </div>
        <button className="btn btn-accent" disabled={busy} onClick={() => void runCheck()}>
          {t("reg.checkCompat")}
        </button>
      </div>
      {check && (
        <div className={`rounded border px-2.5 py-2 text-11 ${check.isCompatible ? "border-ok/40 bg-ok/10" : "border-danger/40 bg-danger/10"}`}>
          <div className="flex items-center gap-1.5 font-medium text-ink-100">
            {check.isCompatible ? <CheckCircle2 size={13} className="text-ok" /> : <XCircle size={13} className="text-danger" />}
            {check.isCompatible ? t("reg.compatible") : t("reg.incompatible")}
          </div>
          {check.messages && check.messages.length > 0 && (
            <ul className="mt-1 space-y-0.5 text-10 text-ink-300 selectable">
              {check.messages.map((m, i) => (
                <li key={i} className="font-mono">· {prettyRegMessage(m)}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      <label className="block text-11 text-ink-300">
        <span className="mb-1 block">{t("reg.candidate")}</span>
        <textarea
          className="field w-full font-mono"
          rows={12}
          spellCheck={false}
          value={candidate}
          onChange={(e) => setCandidate(e.target.value)}
        />
      </label>
      <div className="flex items-center gap-2">
        <button className="btn" disabled={!latest} onClick={() => setCandidate(prettySchema(latest?.schema ?? subject.schema))}>
          {t("reg.candidateFillLatest")}
        </button>
        <div className="flex-1" />
      </div>
    </div>
  );
}

function prettySchema(schema: string): string {
  try {
    return JSON.stringify(JSON.parse(schema), null, 2);
  } catch {
    return schema;
  }
}

// CP 8 verbose messages are single-quoted JS-object dumps like
// {errorType:'TYPE_MISMATCH', description:'...', additionalInfo:'...'} —
// and description values themselves contain single quotes, so naive regex
// capture breaks. Parse by known-key delimiters instead; anything without
// a description stays raw (e.g. {oldSchemaVersion: 2}).
function prettyRegMessage(m: string): string {
  const between = (s: string, start: string, end: string) => {
    const i = s.indexOf(start);
    if (i < 0) return undefined;
    const from = i + start.length;
    const j = end ? s.indexOf(end, from) : s.length;
    return j > from ? s.slice(from, j) : undefined;
  };
  const desc = between(m, "description:'", "', additionalInfo") ?? between(m, "description:'", "'}");
  if (!desc) return m;
  const extra = between(m, "additionalInfo:'", "'}") ?? between(m, "errorType:'", "', description");
  return extra ? `${desc}（${extra}）` : desc;
}
