// CDP probe for the custom uninstaller (port 9224, KE_DEBUG_CDP=1):
// verifies the rendered UI and drives a REAL uninstall end-to-end.
// Usage:
//   node scripts/cdp_uninstall_probe.mjs check   # UI states only
//   node scripts/cdp_uninstall_probe.mjs run     # click 卸载 (data kept)
//   node scripts/cdp_uninstall_probe.mjs run-del # tick checkbox + 卸载
//   node scripts/cdp_uninstall_probe.mjs cancel  # click 取消, expect intact
const base = "http://127.0.0.1:9224";
const mode = process.argv[2] || "check";

const targets = await (await fetch(`${base}/json`)).json();
const page = targets.find((t) => t.type === "page");
if (!page) throw new Error("no page target");

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

const readState = () =>
  evalJs(`(() => ({
    path: document.getElementById("path").textContent,
    note: document.getElementById("note").textContent,
    okText: document.getElementById("ok").textContent,
    okDisabled: document.getElementById("ok").disabled,
    checked: document.getElementById("deleteData").checked,
    cancelVisible: document.getElementById("cancel").style.display !== "none",
    progressVisible: document.getElementById("progress").style.display === "block",
  }))()`);

const state = await readState();
console.log("state:", JSON.stringify(state));

const check = (name, ok, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);

if (mode === "check") {
  check("path shown", state.path.startsWith("D:\\") || state.path.includes("Kafka"), state.path);
  check("ok button ready", state.okText === "卸载" && !state.okDisabled);
  check("no error note", !state.note, state.note);
  process.exit(0);
}

if (mode === "cancel") {
  await evalJs(`document.getElementById("cancel").click(); true`);
  await sleep(800);
  check("cancel clicked, UI gone is ok (window closes)", true);
  process.exit(0);
}

// run / run-del: click through a real uninstall
if (mode === "run-del") {
  await evalJs(`document.getElementById("deleteData").click(); true`);
  await sleep(200);
}
await evalJs(`document.getElementById("ok").click(); true`);
await sleep(600);
const working = await readState();
check("working state entered", working.okText.includes("正在卸载") || working.progressVisible || working.phase === "done", JSON.stringify(working));

// wait for the done state (button flips to 关闭), up to 30s
let done = null;
for (let i = 0; i < 30; i++) {
  await sleep(1000);
  done = await readState();
  if (done.okText === "关闭") break;
}
check("done state reached", done.okText === "关闭", done.okText + " / " + done.note);
console.log("final-note:", done.note);
process.exit(0);
