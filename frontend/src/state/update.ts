// App-update lifecycle state: SESSION-GLOBAL, not component-local. The
// staged download keeps running in the background while the user navigates
// away from Settings — with component state the "已暂存" result was lost on
// remount (the done event carried the old request id and no listener was
// alive to catch it), leaving the user to re-download ~50 MB. The store is
// the single owner; its wails-event listeners live at MODULE scope so they
// survive unmounts for the whole app session.
import { create } from "zustand";
import { Events } from "@wailsio/runtime";

export type UpdatePhase = "idle" | "downloading" | "staged" | "installing";

export function newReqID(): string {
  return `u-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

interface UpdateState {
  phase: UpdatePhase;
  reqID: string;
  bytes: number;
  total: number;
  route: string;
  staged: string;
  error: string;
  begin: (reqID: string, total: number) => void;
  progress: (bytes: number, total: number, route: string) => void;
  done: (failed: boolean, staged: string, error: string) => void;
  cancel: () => void;
  toInstalling: () => void;
  installFailed: (msg: string) => void;
}

export const useUpdate = create<UpdateState>((set) => ({
  phase: "idle",
  reqID: newReqID(), // stable while idle; begin() rotates it per download
  bytes: 0,
  total: 0,
  route: "",
  staged: "",
  error: "",
  begin: (reqID, total) =>
    set({ reqID, total, bytes: 0, route: "", error: "", phase: "downloading" }),
  progress: (bytes, total, route) => set({ bytes, total, route }),
  // The backend's done contract: failed=true carries the error; failed=false
  // with an EMPTY staged path is a CANCELLED download (idle, no error);
  // failed=false with a path is a staged success.
  done: (failed, staged, error) =>
    set(
      failed
        ? { phase: "idle", staged: "", error }
        : staged
          ? { phase: "staged", staged, error: "" }
          : { phase: "idle", staged: "", error: "" },
    ),
  // Optimistic UI on the stop button; the backend's own done event lands
  // right after and maps to the same idle state.
  cancel: () => set({ phase: "idle", error: "" }),
  toInstalling: () => set({ phase: "installing" }),
  installFailed: (msg) => set({ phase: "staged", error: msg }),
}));

let wired = false;
function wire() {
  if (wired) return;
  wired = true;
  Events.On("system:update:progress", (ev: unknown) => {
    const data = (ev as { data?: { id: string; bytes: number; total: number; route?: string } })?.data;
    const s = useUpdate.getState();
    if (!data || data.id !== s.reqID) return;
    s.progress(data.bytes, data.total, data.route ?? "");
  });
  Events.On("system:update:done", (ev: unknown) => {
    const data = (ev as { data?: { id: string; failed: boolean; staged: string; error?: string } })?.data;
    const s = useUpdate.getState();
    if (!data || data.id !== s.reqID) return;
    // Cancelled staging arrives as failed=false with an EMPTY path — that
    // pair means "stopped", not "staged" (AboutSection done-contract).
    s.done(data.failed, data.staged ?? "", data.error ?? "");
  });
}
wire();
