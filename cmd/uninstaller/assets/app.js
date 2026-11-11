// Uninstaller UI state machine. Calls the uninstaller service through the
// wails runtime served at /wails/runtime.js (vanilla page — no bundler).
// The numeric IDs are the FNV method hashes `wails3 generate bindings`
// emits for kafkaexplorer/internal/uninstaller (see service.js in the
// generated output; regenerate and re-read after renaming methods).

import { Call, Window, Events } from "/wails/runtime.js";

const ID_INFO = 337019437;      // Service.Info() → Info
const ID_UNINSTALL = 4203829041; // Service.Uninstall(deleteData) → error?

const $ = (id) => document.getElementById(id);
const okBtn = $("ok");
const cancelBtn = $("cancel");
const closeBtn = $("close");
const pathEl = $("path");
const noteEl = $("note");
const progressEl = $("progress");
const barEl = $("bar");
const deleteDataEl = $("deleteData");
const optionsGroup = $("optionsGroup");

let phase = "loading"; // loading | ready | running | done

function setNote(text, isError = false) {
  noteEl.textContent = text;
  noteEl.classList.toggle("error", isError);
}

// ---- real progress with elegant pacing (mirrors the setup window) ----
// The Go service streams Inno-log-derived percentages; a typical uninstall
// finishes in ~2s, so the bar animates toward the latest reported value
// and never completes before MIN_RUNTIME has elapsed.
const MIN_RUNTIME = 2000; // ms
const bar = { current: 2, target: 0, timer: null, started: 0, resolveDone: null, done: null };

function barStart() {
  bar.current = 2;
  bar.target = 6;
  bar.started = performance.now();
  progressEl.style.display = "block";
  barEl.style.transition = "none";
  barEl.style.animation = "none";
  barEl.style.width = "2%";
  bar.done = new Promise((res) => { bar.resolveDone = res; });
  bar.timer = setInterval(barStep, 40);
}

function barStep() {
  const elapsed = performance.now() - bar.started;
  const floor = Math.min(60, (96 * elapsed) / MIN_RUNTIME);
  const goal = Math.max(bar.target, floor);
  bar.current += (goal - bar.current) * 0.18;
  if (bar.target >= 100 && bar.current >= 99.5 && elapsed >= MIN_RUNTIME) {
    bar.current = 100;
    barEl.style.width = "100%";
    clearInterval(bar.timer);
    bar.timer = null;
    bar.resolveDone();
    return;
  }
  barEl.style.width = bar.current.toFixed(1) + "%";
}

function barAbort() {
  if (bar.timer) { clearInterval(bar.timer); bar.timer = null; }
  progressEl.style.display = "none";
}

Events.On("uninstall:progress", (ev) => {
  bar.target = ev?.data?.pct ?? bar.target;
});

function setWorking(on) {
  phase = on ? "running" : "ready";
  okBtn.disabled = on;
  cancelBtn.style.display = on ? "none" : "";
  closeBtn.disabled = on;
  if (!on) {
    progressEl.style.display = "none";
    barEl.style.width = "0%";
  }
}

async function loadInfo() {
  try {
    // Call resolves straight to the JSON result (runtime.js: response.json())
    const info = await Call.ByID(ID_INFO);
    if (!info.appPath) {
      pathEl.textContent = "未找到安装信息";
      setNote("未检测到已安装的 Kafka Explorer。", true);
      return;
    }
    pathEl.textContent = info.appPath;
    phase = "ready";
    if (info.appRunning) {
      // blocked state: poll until the app exits, then recover in place —
      // the user should never have to reopen the uninstaller
      okBtn.disabled = true;
      setNote("检测到 Kafka Explorer 正在运行。退出应用后将自动允许继续卸载。", true);
      startRunningPoll();
    } else {
      okBtn.disabled = false;
    }
  } catch {
    pathEl.textContent = "未找到安装信息";
    setNote("读取安装信息失败。", true);
  }
}

let runningPoll = null;

// while blocked by a running app, re-check every 1.5s and auto-enable
function startRunningPoll() {
  if (runningPoll) return;
  runningPoll = setInterval(async () => {
    try {
      const info = await Call.ByID(ID_INFO);
      if (!info.appRunning && phase === "ready") {
        clearInterval(runningPoll);
        runningPoll = null;
        okBtn.disabled = false;
        setNote("");
      }
    } catch {
      /* transient registry hiccup: keep polling */
    }
  }, 1500);
}

async function uninstall() {
  if (phase !== "ready") return;
  setWorking(true);
  setNote("");
  barStart();
  okBtn.textContent = "正在卸载…";
  try {
    await Call.ByID(ID_UNINSTALL, deleteDataEl.checked);
    bar.target = 100;
    await bar.done; // sweep finishes before the done state appears
    // done: hide the now-meaningless options group (delete-data checkbox
    // + 卸载自 path) and the progress bar; the only action left is 关闭
    optionsGroup.style.display = "none";
    progressEl.style.display = "none";
    phase = "done";
    okBtn.textContent = "关闭";
    okBtn.disabled = false;
    setNote(
      deleteDataEl.checked
        ? "卸载完成：程序与用户数据已删除。"
        : "卸载完成：用户数据已保留，下次安装后可继续使用。",
    );
  } catch (err) {
    // back to a retryable ready state with the friendly message from Go
    barAbort();
    setWorking(false);
    okBtn.textContent = "卸载";
    setNote(String(err).replace(/^(?:Runtime)?Error:\s*/, ""), true);
  }
}

okBtn.addEventListener("click", () => {
  if (phase === "done") void Window.Close();
  else void uninstall();
});
cancelBtn.addEventListener("click", () => void Window.Close());
closeBtn.addEventListener("click", () => {
  if (phase !== "running") void Window.Close();
});

void loadInfo();
