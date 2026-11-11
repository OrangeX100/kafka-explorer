// Setup UI state machine. Calls the setup service through the wails
// runtime served at /wails/runtime.js (vanilla page — no bundler).
// The numeric IDs are the FNV method hashes `wails3 generate bindings`
// emits for cmd/setup (see setupservice.js; regenerate and re-read after
// renaming methods).

import { Call, Window, Events } from "/wails/runtime.js";

const ID_INFO = 3891831768;        // Service.Info() → Info
const ID_DEFAULT_DIR = 1899062312; // Service.DefaultDir() → string
const ID_INSTALL = 3924648799;     // Service.Install(dir) → error?
const ID_LAUNCH = 1973267802;      // Service.LaunchApp(dir) → error?
const ID_PICK_DIR = 976529420;     // Service.PickDir(title) → string

const $ = (id) => document.getElementById(id);
const okBtn = $("ok");
const cancelBtn = $("cancel");
const closeBtn = $("close");
const pathInput = $("path");
const browseBtn = $("browse");
const noteEl = $("note");
const progressEl = $("progress");
const barEl = $("bar");
const upgradeLine = $("upgradeLine");
const prevVersionEl = $("prevVersion");
const pathGroup = $("pathGroup");
const launchCheck = $("launchCheck");
const launchNow = $("launchNow");

let phase = "loading"; // loading | ready | running | done
let upgrade = false;
let installDir = ""; // remembered for the done-state launch

function setNote(text, isError = false) {
  noteEl.textContent = text;
  noteEl.classList.toggle("error", isError);
}

// ---- real progress with elegant pacing ----
// The Go service streams Inno-log-derived percentages on setup:progress.
// An install of this size finishes in ~2s, so a naive bar would snap
// full almost instantly. The bar instead ANIMATES toward the latest
// reported value and never reaches full before MIN_RUNTIME has elapsed:
// fast installs get a smooth sweep, slow installs still track real
// progress (the reported value outruns the floor).
const MIN_RUNTIME = 2400; // ms — the bar always takes at least this long
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
  // linear floor guarantees the sweep takes MIN_RUNTIME even when the
  // real install finished instantly; easing catches up to real events
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

Events.On("setup:progress", (ev) => {
  bar.target = ev?.data?.pct ?? bar.target;
});

function setWorking(on) {
  phase = on ? "running" : "done";
  okBtn.disabled = on;
  browseBtn.disabled = on;
  pathInput.disabled = on;
  closeBtn.disabled = on;
  if (!on) {
    progressEl.style.display = "none";
    barEl.style.width = "0%";
  }
}

async function loadInfo() {
  try {
    const [info, suggested] = await Promise.all([
      Call.ByID(ID_INFO),
      Call.ByID(ID_DEFAULT_DIR),
    ]);
    pathInput.value = suggested || "";
    if (!suggested) {
      setNote("读取安装信息失败，请重启安装程序。", true);
      return;
    }
    if (info.prevDir && info.version) {
      upgradeLine.style.display = "";
      prevVersionEl.textContent = info.version;
      okBtn.textContent = "升级";
      upgrade = true;
    }
    phase = "ready";
    if (info.appRunning) {
      // blocked state: poll until the app exits, then recover in place —
      // the user should never have to reopen the setup program
      okBtn.disabled = true;
      setNote("检测到 Kafka Explorer 正在运行。退出应用后将自动允许继续安装。", true);
      startRunningPoll();
    } else {
      okBtn.disabled = false;
    }
  } catch {
    pathInput.value = "（无法确定安装目录）";
    setNote("读取安装信息失败，请重启安装程序。", true);
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

function currentDir() {
  return pathInput.value.trim();
}

// done state: the path group makes no sense anymore (install landed) —
// hide it and offer 启动应用 vs 直接关闭 through the checkbox + buttons.
function enterDone() {
  setWorking(false);
  pathGroup.style.display = "none";
  upgradeLine.style.display = "none";
  launchCheck.style.display = "";
  okBtn.textContent = launchNow.checked ? "启动应用" : "完成";
  cancelBtn.style.display = "none"; // 完成/启动应用 IS the closer now
  setNote("安装完成。");
}

function closeWindow() {
  if (launchNow.checked) {
    // the input is hidden in done state; its value IS the install dir
    Call.ByID(ID_LAUNCH, installDir)
      .catch((err) => setNote(String(err).replace(/^(?:Runtime)?Error:\s*/, ""), true))
      .finally(() => void Window.Close());
  } else {
    void Window.Close();
  }
}

async function install() {
  const dir = currentDir();
  if (!dir) {
    setNote("请填写安装目录。", true);
    return;
  }
  installDir = dir;
  setWorking(true);
  setNote("");
  barStart();
  const primaryLabel = okBtn.textContent;
  okBtn.textContent = "正在安装…";
  try {
    await Call.ByID(ID_INSTALL, dir);
    // sweep to 100 even if the last watcher event hasn't landed yet —
    // the bar finishes its run before the done state appears
    bar.target = 100;
    await bar.done;
    enterDone();
  } catch (err) {
    barAbort();
    setWorking(false);
    phase = "ready";
    okBtn.textContent = primaryLabel;
    setNote(String(err).replace(/^(?:Runtime)?Error:\s*/, ""), true);
  }
}

okBtn.addEventListener("click", () => {
  if (phase === "done") {
    closeWindow();
    return;
  }
  void install();
});

// flipping the checkbox relabels the primary button so the choice is
// readable BEFORE clicking
launchNow.addEventListener("change", () => {
  if (phase === "done") okBtn.textContent = launchNow.checked ? "启动应用" : "完成";
});

// 浏览 opens the native folder picker; blank result = cancelled. A bare
// drive root gets one appDirName level appended client-side so the user
// sees exactly where it will install.
browseBtn.addEventListener("click", async () => {
  try {
    let picked = await Call.ByID(ID_PICK_DIR, "选择安装目录");
    if (picked) {
      if (/^[a-zA-Z]:\\?$/.test(picked.replace(/\\/g, "\\"))) {
        picked = picked.replace(/\\+$/, "") + "\\Kafka Explorer";
      }
      pathInput.value = picked;
    }
  } catch {
    /* cancelled or transient — keep the current value */
  }
});

cancelBtn.addEventListener("click", () => void Window.Close());
closeBtn.addEventListener("click", () => {
  if (phase !== "running") void Window.Close();
});

void loadInfo();
