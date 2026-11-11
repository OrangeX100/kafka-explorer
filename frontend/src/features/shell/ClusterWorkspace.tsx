import { Gauge, Network, Server, Share2, ShieldCheck, Users } from "lucide-react";
import { useWorkspace } from "../../state/workspace.js";
import { t } from "../../shared/i18n.js";
import { TopicsView } from "../topics/TopicsView.js";
import { GroupsView } from "../groups/GroupsView.js";
import { ShareGroupsView } from "../groups/ShareGroupsView.js";
import { BrokersView } from "../admin/BrokersView.js";
import { ACLsView } from "../admin/ACLsView.js";
import { QuotasView } from "../admin/QuotasView.js";
import { CompareView } from "../admin/CompareView.js";
import { TabBar } from "./TabBar.js";

// titleKey is resolved at RENDER time via t() — a module-level t() call
// would freeze the locale at first import (user-reported: switching to
// English left these tabs Chinese).
const SECTIONS: { view: "topics" | "groups" | "share" | "brokers" | "acls" | "quotas" | "compare"; icon: React.ReactNode; titleKey: string }[] = [
  { view: "topics", icon: <Network size={13} />, titleKey: "sidebar.topics" },
  { view: "groups", icon: <Users size={13} />, titleKey: "sidebar.groups" },
  { view: "share", icon: <Share2 size={13} />, titleKey: "sidebar.share" },
  { view: "brokers", icon: <Server size={13} />, titleKey: "ws.brokers" },
  { view: "acls", icon: <ShieldCheck size={13} />, titleKey: "ws.acls" },
  { view: "quotas", icon: <Gauge size={13} />, titleKey: "ws.quotas" },
  { view: "compare", icon: null, titleKey: "ws.compare" },
];

// The per-connection workspace: a TabBar of open clusters on top, then the
// active tab's section switcher, then one kept-mounted pane per tab. Every
// tab renders its own section's view; hidden tabs keep their component
// state (selections, scroll) across cluster switches.
export function ClusterWorkspace({ onAddConnection }: { onAddConnection: () => void }) {
  const tabs = useWorkspace((s) => s.tabs);
  const activeId = useWorkspace((s) => s.activeId);
  const setSection = useWorkspace((s) => s.setSection);
  const active = tabs.find((tb) => tb.connectionId === activeId) ?? null;

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-ink-950">
      <TabBar onAddConnection={onAddConnection} />
      {active && (
        <div className="flex flex-none items-center gap-1 border-b border-ink-700 bg-ink-900 px-2 py-1.5">
          {SECTIONS.map((s) => (
            <button
              key={s.view}
              className={`btn ${active.section === s.view ? "btn-accent" : ""}`}
              onClick={() => setSection(s.view)}
            >
              {s.icon} {t(s.titleKey)}
            </button>
          ))}
          <div className="flex-1" />
        </div>
      )}
      <div className="min-h-0 flex-1">
        {tabs.map((tb) => (
          <div key={tb.connectionId} className={`h-full ${tb.connectionId === activeId ? "" : "hidden"}`}>
            <div key={tb.section} className="anim-fade h-full">
              {tb.section === "topics" && <TopicsView connectionId={tb.connectionId} />}
              {tb.section === "groups" && <GroupsView connectionId={tb.connectionId} />}
              {tb.section === "share" && <ShareGroupsView connectionId={tb.connectionId} />}
              {tb.section === "brokers" && <BrokersView connectionId={tb.connectionId} />}
              {tb.section === "acls" && <ACLsView connectionId={tb.connectionId} />}
              {tb.section === "quotas" && <QuotasView connectionId={tb.connectionId} />}
              {tb.section === "compare" && <CompareView />}
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}
