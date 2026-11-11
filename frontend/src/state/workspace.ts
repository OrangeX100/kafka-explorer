// Workspace state: open cluster tabs and per-tab section. Kept separate from
// stores.ts so each slice stays under the structure budget and the tab model
// has a single owner. Tabs are SESSION-SCOPED by design: a fresh app start
// shows a clean workspace (no auto-restored "connected" tabs) — opening a
// connection is always a deliberate act. Only the list-collapsed layout
// preference persists.
import { create } from "zustand";
import { connectionsApi } from "../shared/api.js";

export type Section = "topics" | "groups" | "share" | "brokers" | "acls" | "quotas" | "compare";

// Connection-list visibility: the list auto-collapses when a connection is
// opened (three-pane -> two-pane, content gets the width back) and comes
// back via the rail toggle, the list-header « button stays for manual
// collapse. The choice is remembered across sessions; with no active
// connection the list always shows (Sidebar enforces that rule).
const LIST_KEY = "ke.listCollapsed";

function storedListOpen(): boolean {
  return localStorage.getItem(LIST_KEY) !== "0";
}

function persistListOpen(open: boolean) {
  localStorage.setItem(LIST_KEY, open ? "1" : "0");
}

// One tab per open cluster. Each tab keeps its own section; the view
// components stay mounted while the tab exists, so switching clusters
// preserves selections and scroll positions (the lists themselves refresh
// on re-activation — the data is live). Closing a tab never deletes the
// connection. The tab set is remembered across sessions.
export interface ConnectionTab {
  connectionId: string;
  name: string;
  section: Section;
}

// Per-connection broker reachability, probed by the Sidebar while a tab is
// open. Only ok/fail are recorded; "unknown" is the absence of a key (tab
// open but no probe result yet).
export type Health = "ok" | "fail";

interface WorkspaceState {
  tabs: ConnectionTab[];
  activeId: string | null;
  listOpen: boolean;
  health: Record<string, Health>;
  setHealth: (id: string, h: Health) => void;
  setListOpen: (open: boolean) => void;
  open: (connectionId: string, name: string) => void;
  closeTab: (connectionId: string) => void;
  closeOthers: (connectionId: string) => void;
  closeAll: () => void;
  // Drop tabs whose connection was deleted (called after a successful removal).
  pruneTabs: (validIds: string[]) => void;
  setSection: (s: Section) => void;
}

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  tabs: [],
  activeId: null,
  listOpen: storedListOpen(),
  health: {},
  setHealth: (id, h) => set({ health: { ...get().health, [id]: h } }),
  setListOpen: (open) => {
    persistListOpen(open);
    set({ listOpen: open });
  },
  open: (connectionId, name) => {
    // Opening a tab no longer collapses the list and never assumes success:
    // the Sidebar's openFlow probes the broker and collapses only when the
    // FIRST connection verifies reachable (multi-open keeps the list put).
    const { tabs } = get();
    if (tabs.some((t) => t.connectionId === connectionId)) {
      set({ activeId: connectionId });
      return;
    }
    const next: ConnectionTab[] = [...tabs, { connectionId, name, section: "topics" }];
    set({ tabs: next, activeId: connectionId });
  },
  closeTab: (connectionId) => {
    const { tabs, activeId } = get();
    const idx = tabs.findIndex((t) => t.connectionId === connectionId);
    if (idx === -1) return;
    // Closing the session drops the pooled client (fire-and-forget).
    void connectionsApi.disconnect(connectionId).catch(() => {});
    const next = tabs.filter((t) => t.connectionId !== connectionId);
    // Closing the active tab activates the right neighbour, else the left.
    const nextActive =
      activeId === connectionId ? (next[idx] ?? next[idx - 1])?.connectionId ?? null : activeId;
    if (nextActive === null) persistListOpen(true); // nothing open: list returns
    set({ tabs: next, activeId: nextActive, ...(nextActive === null ? { listOpen: true } : {}) });
  },
  closeOthers: (connectionId) => {
    const { tabs, activeId } = get();
    // Drop pooled clients for every closed session (fire-and-forget).
    for (const t of tabs) if (t.connectionId !== connectionId) void connectionsApi.disconnect(t.connectionId).catch(() => {});
    const next = tabs.filter((t) => t.connectionId === connectionId);
    if (next.length === tabs.length) return;
    const nextActive = next.some((t) => t.connectionId === activeId) ? activeId : connectionId;
    set({ tabs: next, activeId: nextActive });
  },
  closeAll: () => {
    const { tabs } = get();
    for (const t of tabs) void connectionsApi.disconnect(t.connectionId).catch(() => {});
    persistListOpen(true); // nothing open: list returns
    set({ tabs: [], activeId: null, listOpen: true });
  },
  pruneTabs: (validIds) => {
    const { tabs, activeId } = get();
    const next = tabs.filter((t) => validIds.includes(t.connectionId));
    if (next.length === tabs.length) return;
    const nextActive = next.some((t) => t.connectionId === activeId) ? activeId : (next[0]?.connectionId ?? null);
    set({ tabs: next, activeId: nextActive });
  },
  setSection: (section) => {
    const { tabs, activeId } = get();
    if (!activeId) return;
    const next = tabs.map((t) => (t.connectionId === activeId ? { ...t, section } : t));
    set({ tabs: next });
  },
}));
