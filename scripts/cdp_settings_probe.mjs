// CDP probe for the settings page (port 9223, KE_DEBUG_CDP=1):
//  1. appearance regression: every <select-like> option click applies
//  2. CJK font row: value renders on ONE line (no clipped wrap)
//  3. backup import: a backup file merges into the live config
// Usage: node scripts/cdp_settings_probe.mjs
const base = "http://127.0.0.1:9223";

const targets = await (await fetch(`${base}/json`)).json();
// KE_DEBUG_CDP=1 also opens DevTools windows — each is a page target;
// filter them out and keep the actual app page
const page = targets.find((t) => t.type === "page" && !t.url.startsWith("devtools://"));
if (!page) throw new Error("no app page target (only devtools windows found)");

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let seq = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evalJs = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval failed");
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const check = (name, ok, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);

// fresh load so the new bundle is authoritative
await send("Page.enable");
await send("Page.reload", { ignoreCache: true });
await sleep(2500);

// navigate to the settings view via the rail button
await evalJs(`(() => {
  const btn = [...document.querySelectorAll("nav button")].find(b => (b.dataset.tip || "").includes("设置") || (b.dataset.tip || "").includes("Settings"));
  if (btn) btn.click();
  return true;
})()`);
await sleep(600);

// ---- 1) appearance: click the theme trigger, then pick an option ----
// The row order is fixed: 主题/语言/字号/行高/西文/中文; theme = first select.
const before = await evalJs(`(() => {
  const trigger = document.querySelector(".ke-select-trigger");
  return trigger ? trigger.textContent : null;
})()`);
const wantTheme = before?.includes("dark") || before?.includes("暗色") || before?.includes("深色") ? "light" : "dark";
// open the first dropdown and click the option whose text matches the target theme
await evalJs(`document.querySelector(".ke-select-trigger").click(); true`);
await sleep(300);
const clicked = await evalJs(`(() => {
  const items = [...document.querySelectorAll(".ke-select-item")];
  const target = items.find(b => b.textContent.toLowerCase().includes("${wantTheme}") || b.textContent.includes("${wantTheme === "light" ? "亮色" : "暗色"}"));
  if (!target) return { ok: false, options: items.map(b => b.textContent) };
  target.click();
  return { ok: true };
})()`);
await sleep(900); // debounce 600ms + save round trip
const after = await evalJs(`(() => {
  const trigger = document.querySelector(".ke-select-trigger");
  return trigger ? trigger.textContent : null;
})()`);
check("select option click applies (portal fix)", clicked.ok && after?.includes(wantTheme === "light" ? "亮色" : "暗色"),
  `before=[${before}] after=[${after}]`);
// restore: pick the previous theme back through the same path
await evalJs(`document.querySelector(".ke-select-trigger").click(); true`);
await sleep(300);
await evalJs(`(() => {
  const prev = ${JSON.stringify(before)};
  const items = [...document.querySelectorAll(".ke-select-item")];
  const target = items.find(b => prev.includes("亮色") ? b.textContent.includes("亮色") : b.textContent.toLowerCase().includes("dark"));
  if (target) target.click();
  return true;
})()`);
await sleep(900);

// ---- 2) CJK font row renders on one line ----
const fontRow = await evalJs(`(() => {
  const values = [...document.querySelectorAll(".ke-select-value > span")];
  const v = values[values.length - 1]; // last row = 中文/西文 select
  if (!v) return null;
  const cs = getComputedStyle(v);
  return { scrollH: v.scrollHeight, clientH: v.clientHeight, whiteSpace: cs.whiteSpace, text: v.textContent };
})()`);
check("font value single-line (no clipped wrap)",
  !!fontRow && fontRow.whiteSpace === "nowrap" && fontRow.scrollH <= fontRow.clientH + 2,
  JSON.stringify(fontRow));

// ---- 3) backup import merges into the live config ----
// The backup file is pre-written by the caller (webview JS cannot touch
// the host FS); this probe only passes the PATH to ImportBackup.
const backupPath = "C:\\Users\\51293\\AppData\\Local\\Temp\\ke_probe_backup.json";
const regCountBefore = await evalJs(`(async () => {
  const { Call } = await import("/wails/runtime.js");
  const list = await Call.ByID(536898366); // SchemaRegistryHandler.List
  return Array.isArray(list) ? list.length : 0;
})()`);
await evalJs(`(async () => {
  const { Call } = await import("/wails/runtime.js");
  await Call.ByID(2036896464, ${JSON.stringify(backupPath)}); // SettingsHandler.ImportBackup
  return true;
})()`);
const regCountAfter = await evalJs(`(async () => {
  const { Call } = await import("/wails/runtime.js");
  const list = await Call.ByID(536898366);
  return Array.isArray(list) ? list.length : 0;
})()`);
check("backup import merged registry", regCountAfter === regCountBefore + 1,
  `before=${regCountBefore} after=${regCountAfter}`);
const imported = await evalJs(`(async () => {
  const { Call } = await import("/wails/runtime.js");
  const list = await Call.ByID(536898366);
  return list.filter(r => r.name === "cdp-probe-sr").length;
})()`);
check("imported registry present with kept name", imported === 1);

console.log("settings probe finished");
