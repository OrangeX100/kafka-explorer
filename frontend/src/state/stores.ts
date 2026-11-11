// Application state. Three stores with clear ownership:
// - connections (here): the saved list (refreshed after mutations)
// - workspace (state/workspace.ts): open cluster tabs + per-tab section
// - messages: per-view message browsing state lives in the component itself
import { create } from "zustand";
import type { Connection } from "../shared/contracts.js";
import { connectionsApi, classifyError } from "../shared/api.js";
import { t } from "../shared/i18n.js";

interface ConnectionsState {
  list: Connection[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export const useConnections = create<ConnectionsState>((set) => ({
  list: [],
  loading: false,
  error: null,
  refresh: async () => {
    set({ loading: true, error: null });
    try {
      const list = (await connectionsApi.list()) ?? [];
      set({ list, loading: false });
    } catch (err) {
      const { key, detail } = classifyError(err);
      set({ loading: false, error: `${t(key)}: ${detail}` });
    }
  },
}));

// A global toast topic for transient errors/successes. `id` increments per
// show so the ToastHost can key its enter animation even when the text is
// identical to the previous toast.
interface ToastState {
  id: number;
  message: string | null;
  kind: "info" | "error" | "ok";
  show: (msg: string, kind?: ToastState["kind"]) => void;
  clear: () => void;
}

export const useToast = create<ToastState>((set) => ({
  id: 0,
  message: null,
  kind: "info",
  show: (message, kind = "info") => {
    set((s) => ({ id: s.id + 1, message, kind }));
  },
  clear: () => set({ message: null }),
}));
