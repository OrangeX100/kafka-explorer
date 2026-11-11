import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Copy, Pencil, Plus, Undo2 } from "lucide-react";
import { topicsApi } from "../../shared/api.js";
import { useToast } from "../../state/stores.js";
import { t } from "../../shared/i18n.js";
import { configName, configDesc } from "../../shared/configLocale.js";
import { configHint } from "../../shared/humanize.js";
import { clientToLayout, viewportW } from "../../shared/zoom.js";
import { useContextMenu } from "../common/ContextMenu.js";
import { confirmDialog } from "../common/ConfirmDialog.js";
import { useCopy } from "../../shared/useCopy.js";
import { AddConfigDialog, ConfigEditDialog } from "./ConfigDialogs.js";
import { TOPIC_CONFIG_DOCS } from "../../shared/topicConfigDocs.js";
import type { ConfigEntry, TopicDetail } from "../../shared/contracts.js";
import { friendlyError } from "../../shared/api.js";

// Fixed-position tooltip: native title takes ~1s to appear and the
// overflow-auto table clips CSS-positioned tooltips, so hover text renders
// in a portal at the pointer instead.
function useHoverTip() {
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null);
  const show = (text: string | undefined) => (e: React.MouseEvent) => {
    if (!text) return;
    // clientX/Y are viewport px; the body may be zoomed (界面字号) — convert
    // into layout pixels before positioning the portal.
    setTip({ text, x: clientToLayout(e.clientX), y: clientToLayout(e.clientY) });
  };
  const move = (e: React.MouseEvent) => {
    setTip((cur) => (cur ? { ...cur, x: clientToLayout(e.clientX), y: clientToLayout(e.clientY) } : cur));
  };
  const hide = () => setTip(null);
  const host = tip
    ? createPortal(
        <div
          className="pointer-events-none fixed z-[90] max-w-md rounded border border-ink-600 bg-ink-850 px-2.5 py-1.5 text-11 leading-relaxed text-ink-100 shadow-xl"
          style={{ left: Math.min(tip.x + 14, viewportW() - 460), top: tip.y + 16 }}
        >
          {tip.text.split("\n").map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>,
        document.body,
      )
    : null;
  return { show, move, hide, host };
}

// TopicConfigs: the topic config panel — complete zh dictionary, inline
// value editing (switch / dropdown / text with instant AlterConfig), a
// per-row context menu (modify / delete override / copy), an add-config
// dialog with dictionary autocomplete, and a revert-to-default switch in
// the edit dialog. Offsets Explorer's Config page, modernized.
export function TopicConfigs({
  connectionId,
  detail,
  isProtected,
  onReload,
}: {
  connectionId: string;
  detail: TopicDetail | null;
  // undefined-safe: protected topics render a read-only config pane
  // (Kafka __-internal AND ecosystem-managed — see shared/kafkaInternal.ts)
  isProtected?: boolean;
  onReload: () => void;
}) {
  const [editing, setEditing] = useState<ConfigEntry | null>(null);
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState("");
  const tip = useHoverTip();
  const toast = useToast();
  const copy = useCopy();
  const { open: openCtx, menu: ctxMenu } = useContextMenu();

  // Hooks run unconditionally: an early return ABOVE a hook crashes React
  // (#310 "rendered more hooks than previous render") when the first mount
  // had no detail and the next render did — which blanked the whole app.
  const configs = useMemo(
    () => (detail ? [...detail.config].sort((a, b) => a.name.localeCompare(b.name)) : []),
    [detail],
  );

  if (!detail) return null;

  const filtered = configs.filter(
    (c) => !filter || c.name.toLowerCase().includes(filter.toLowerCase()),
  );
  const overrides = configs.filter((c) => !c.default).length;

  const apply = async (name: string, value: string | null) => {
    try {
      await topicsApi.alterConfig({ connectionId, topic: detail.name, values: { [name]: value } });
      toast.show(value === null ? t("config.revertedOk", name) : `${name} = ${value}`, "ok");
      onReload();
    } catch (err) {
      toast.show(friendlyError(err), "error");
    }
  };

  const removeOverride = async (c: ConfigEntry) => {
    if (
      !(await confirmDialog({
        message: `${t("config.deleteOverride")}：${c.name}？`,
        danger: true,
      }))
    )
      return;
    void apply(c.name, null);
  };

  return (
    <div className="flex h-full flex-col">
      {tip.host}
      {/* toolbar: stats + filter + add */}
      <div className="flex items-center gap-1.5 border-b border-ink-700 bg-ink-900 px-2 py-1.5">
        <span className="text-11 text-ink-400">{t("config.stats", String(configs.length), String(overrides))}</span>
        <div className="flex-1" />
        <input
          className="field !w-44 !py-1"
          placeholder={t("config.filter")}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        {!isProtected && (
          <button className="btn btn-accent !py-1" onClick={() => setAdding(true)}>
            <Plus size={13} /> {t("config.add")}
          </button>
        )}
        {isProtected && (
          <span className="rounded bg-ink-700 px-2 py-1 text-10 text-ink-300" title={t("topics.protectedHint")}>
            {t("topics.protectedConfigNote")}
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <table className="table-fixed w-full border-collapse text-xs">
          <colgroup>
            <col className="w-[22%]" />
            <col className="w-[16%]" />
            <col className="w-[26%]" />
            <col className="w-[10%]" />
            <col className="w-[26%]" />
          </colgroup>
          <thead>
            <tr>
              <th className="table-head px-2 py-1.5 text-left">{t("config.key")}</th>
              <th className="table-head px-2 py-1.5 text-left">{t("config.zhName")}</th>
              <th className="table-head px-2 py-1.5 text-left">{t("config.value")}</th>
              <th className="table-head whitespace-nowrap px-2 py-1.5 text-left">{t("config.default")}</th>
              <th className="table-head whitespace-nowrap px-2 py-1.5 text-center">{t("config.edit")}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((c) => {
              const label = configName(c.name);
              const desc = configDesc(c.name, c.doc);
              const editable = !c.readOnly && !c.sensitive;
              return (
                <tr
                  key={c.name}
                  className="group border-b border-ink-800 hover:bg-ink-850"
                  onContextMenu={(e) =>
                    openCtx(e, [
                      { label: editable ? t("config.edit") : t("config.view"), icon: <Pencil size={13} />, onSelect: () => setEditing(c) },
                      ...(editable && !c.default
                        ? [
                            {
                              label: t("config.deleteOverride"),
                              icon: <Undo2 size={13} />,
                              danger: true,
                              separatorBefore: true,
                              onSelect: () => void removeOverride(c),
                            },
                          ]
                        : []),
                      {
                        label: t("ctx.copyValue"),
                        icon: <Copy size={13} />,
                        separatorBefore: !editable || c.default,
                        onSelect: () => copy(c.sensitive ? "＊＊＊" : c.value),
                      },
                      { label: t("ctx.copyName"), onSelect: () => copy(c.name) },
                      { label: t("ctx.copyDesc"), onSelect: () => copy(desc) },
                    ])
                  }
                >
                  <td
                    className="break-all px-2 py-1.5 font-mono text-ink-200"
                    onMouseEnter={tip.show(c.name)}
                    onMouseMove={tip.move}
                    onMouseLeave={tip.hide}
                  >
                    {c.name}
                  </td>
                  <td
                    className="break-all px-2 py-1.5 text-ink-100"
                    onMouseEnter={tip.show(label)}
                    onMouseMove={tip.move}
                    onMouseLeave={tip.hide}
                  >
                    {label}
                  </td>
                  <td className="px-2 py-1.5">
                    {/* Plain text everywhere in the table — editing only
                        happens in the dialog (click a writable value to open
                        it). Numeric .ms/.bytes values get a human hint line
                        (9223372036854775807 → 无上限 etc.). */}
                    {editable && !isProtected ? (
                      <button
                        type="button"
                        className="-mx-1 block max-w-full rounded px-1 py-0.5 text-left transition-colors hover:bg-ink-800"
                        title={`${t("config.edit")}：${c.name}`}
                        onClick={() => setEditing(c)}
                      >
                        <span className="block break-all font-mono text-ink-100">
                          {c.value === "" ? "∅" : c.value}
                        </span>
                        {(() => {
                          const hint = configHint(c.name, c.value);
                          return hint ? (
                            <span className="block break-all font-mono text-10 text-ink-400">{hint}</span>
                          ) : null;
                        })()}
                      </button>
                    ) : (
                      <span className="block break-all font-mono text-ink-100" title={c.sensitive ? "＊＊＊" : c.value}>
                        {c.sensitive ? "＊＊＊" : c.value === "" ? "∅" : c.value}
                        {(() => {
                          const hint = configHint(c.name, c.value);
                          return hint ? (
                            <span className="block break-all font-mono text-10 text-ink-400">{hint}</span>
                          ) : null;
                        })()}
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-1.5">
                    {c.readOnly ? (
                      <span className="whitespace-nowrap rounded bg-ink-700 px-1.5 py-0.5 text-10 text-ink-200" title={t("config.readOnlyHint")}>
                        {t("config.readOnlyBadge")}
                      </span>
                    ) : c.default ? (
                      <span className="text-11 text-ink-400">{t("config.defaultBadge")}</span>
                    ) : (
                      <span className="whitespace-nowrap rounded bg-accent-muted px-1.5 py-0.5 text-10 text-accent">{t("config.overrideBadge")}</span>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-center">
                    <div className="flex items-center justify-center gap-1">
                      {isProtected ? (
                        <span className="text-10 text-ink-500">{t("topics.protectedHint")}</span>
                      ) : (
                        <>
                          <button
                            className={`btn !px-2 !py-0.5 text-10 ${editable ? "" : "opacity-70"}`}
                            title={editable ? t("config.edit") : t("config.viewTitle")}
                            onClick={() => setEditing(c)}
                          >
                            <Pencil size={11} /> {editable ? t("config.edit") : t("config.view")}
                          </button>
                          {editable && !c.default && (
                            <button
                              className="btn !px-2 !py-0.5 text-10 hover:!text-danger"
                              title={t("config.deleteOverride")}
                              onClick={() => void removeOverride(c)}
                            >
                              <Undo2 size={12} />
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-xs text-ink-400">
                  {t("config.filter")} 0
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {/* scroll-end spacer: the last row must never touch the pane edge */}
        <div className="h-3" />
      </div>

      {ctxMenu}
      {editing && (
        <ConfigEditDialog
          connectionId={connectionId}
          topic={detail.name}
          entry={editing}
          onClose={() => setEditing(null)}
          onSaved={onReload}
        />
      )}
      {adding && (
        <AddConfigDialog
          docs={TOPIC_CONFIG_DOCS}
          existing={configs}
          alter={(name, value) =>
            topicsApi.alterConfig({ connectionId, topic: detail.name, values: { [name]: value } })
          }
          onClose={() => setAdding(false)}
          onSaved={onReload}
        />
      )}
    </div>
  );
}
