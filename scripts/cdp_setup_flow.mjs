// E2E probe for the new setup done-state: bare-drive nesting, real
// progress events, done-state UI (path hidden, launch checkbox).
// Usage: node scripts/cdp_setup_flow.mjs <dir>  (dir "D:" tests nesting)
const base = "http://127.0.0.1:9225";
const targetDir = process.argv[2] || "D:";

const targets = await (await fetch(`${base}/json`)).json();
const page = targets.find((t) => t.type === "page" && t.url === "http://wails.localhost/");
if (!page) { console.log("ERR: no app page target"); process.exit(1); }

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

// capture progress events while installing (Events lives in the page's
// module scope — re-import it inside the evaluated module context)
await evalJs(`(async () => {
  const { Events } = await import("/wails/runtime.js");
  window.__pcts = [];
  Events.On("setup:progress", (ev) => { if (ev && ev.data && typeof ev.data.pct === "number") window.__pcts.push(ev.data.pct); });
})(); true`);
await evalJs(`document.getElementById("path").value = ${JSON.stringify(targetDir)}; true`);
await evalJs(`document.getElementById("ok").click(); true`);

let done = null;
for (let i = 0; i < 45; i++) {
  await sleep(1000);
  done = await evalJs(`JSON.stringify({
    ok: document.getElementById("ok").textContent,
    note: document.getElementById("note").textContent,
    pathHidden: document.getElementById("pathGroup").style.display === "none",
    launchShown: document.getElementById("launchCheck").style.display !== "none",
    launchChecked: document.getElementById("launchNow").checked,
    cancelHidden: document.getElementById("cancel").style.display === "none",
  })`);
  if (JSON.parse(done).ok === "完成" || JSON.parse(done).ok === "启动应用") break;
}
const pcts = await evalJs(`JSON.stringify(window.__pcts)`);
console.log("DONE:", done);
console.log("PROGRESS_EVENTS:", pcts);

// uncheck launch and click → window should close with no app started
await evalJs(`document.getElementById("launchNow").checked = false;
  document.getElementById("launchNow").dispatchEvent(new Event("change"));
  document.getElementById("ok").textContent; true`);
const okLabel = await evalJs(`document.getElementById("ok").textContent`);
console.log("AFTER_UNCHECK_OK_LABEL:", okLabel);
await evalJs(`document.getElementById("ok").click(); true`);
await sleep(1500);
process.exit(0);
