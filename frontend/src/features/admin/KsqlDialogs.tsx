import { useState } from "react";
import { ksqlDbApi, connectApi, friendlyError } from "../../shared/api.js";
import { useToast } from "../../state/stores.js";
import { t } from "../../shared/i18n.js";
import { Modal } from "../common/Modal.js";
import { PlugZap } from "lucide-react";

// Add ksqlDB server dialog — the fields a ksqlDB server needs (name, endpoint
// with Ping, optional API key/secret for authenticated clusters).
export function KsqlDbServerDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const toast = { show: useToast((s) => s.show) };

  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      const [version, , status] = await ksqlDbApi.test(url, username, password);
      setResult(t("ksql.testOk", version, status));
    } catch (err) {
      setResult(friendlyError(err));
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    try {
      await ksqlDbApi.save({ server: { id: "", name, url, username }, password });
      onSaved();
    } catch (err) {
      toast.show(friendlyError(err), "error");
    }
  };

  return (
    <Modal title={t("ksql.addServer")} width={420} onClose={onClose}>
      {(close) => (
        <div className="space-y-2.5">
          <label className="block">
            <span className="mb-1 block text-11 text-ink-300">{t("reg.name")}</span>
            <input className="field" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="block">
            <span className="mb-1 block text-11 text-ink-300">{t("reg.url")}</span>
            <div className="flex gap-1.5">
              <input className="field flex-1 font-mono" placeholder="http://host:8088" value={url} onChange={(e) => setUrl(e.target.value)} />
              <button className="btn flex-none" disabled={testing} onClick={() => void test()}>
                <PlugZap size={13} /> {testing ? t("conn.testing") : t("ksql.ping")}
              </button>
            </div>
          </label>
          <div className="rounded border border-ink-700 bg-ink-900 p-2">
            <div className="mb-1.5 text-10 font-semibold uppercase tracking-wide text-ink-400">{t("ksql.authTitle")}</div>
            <label className="mb-2 block">
              <span className="mb-1 block text-11 text-ink-300">{t("connect.apiKey")}</span>
              <input className="field font-mono" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
            </label>
            <label className="block">
              <span className="mb-1 block text-11 text-ink-300">{t("connect.apiSecret")}</span>
              <input className="field font-mono" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
            </label>
            <div className="mt-1 text-10 text-ink-400">{t("ksql.authHint")}</div>
          </div>
          {result && <div className="rounded border border-ink-600 bg-ink-900 px-2.5 py-2 text-11 selectable">{result}</div>}
          <div className="flex items-center gap-2 border-t border-ink-700 pt-3">
            <div className="flex-1" />
            <button className="btn" onClick={close}>{t("conn.cancel")}</button>
            <button className="btn btn-accent" disabled={!name || !url} onClick={() => void save()}>{t("conn.save")}</button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// Connect auth fields live here too so ConnectView stays in budget.
export function ConnectAuthFields({
  username,
  password,
  onUsername,
  onPassword,
}: {
  username: string;
  password: string;
  onUsername: (v: string) => void;
  onPassword: (v: string) => void;
}) {
  return (
    <div className="rounded border border-ink-700 bg-ink-900 p-2">
      <div className="mb-1.5 text-10 font-semibold uppercase tracking-wide text-ink-400">{t("ksql.authTitle")}</div>
      <label className="mb-2 block">
        <span className="mb-1 block text-11 text-ink-300">{t("connect.apiKey")}</span>
        <input className="field font-mono" value={username} onChange={(e) => onUsername(e.target.value)} autoComplete="off" />
      </label>
      <label className="block">
        <span className="mb-1 block text-11 text-ink-300">{t("connect.apiSecret")}</span>
        <input className="field font-mono" type="password" value={password} onChange={(e) => onPassword(e.target.value)} autoComplete="new-password" />
      </label>
      <div className="mt-1 text-10 text-ink-400">{t("connect.authHint")}</div>
    </div>
  );
}

// re-export keeps the ConnectView import surface single
export { connectApi };
