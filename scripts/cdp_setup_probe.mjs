// CDP probe for the custom setup front-end (port 9225, KE_DEBUG_CDP=1).
// Modes:
//   state    — dump UI state (path input, button, notes)
//   setdir   — type a custom dir into the path input
//   install  — click 安装/升级
//   launch   — click 启动应用 (done state)
// Usage: node scripts/cdp_setup_probe.mjs <mode> [customDir]
const base = "http://127.0.0.1:9225";
const mode = process.argv[2] || "state";
const customDir = process.argv[3] || "";

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

const state = await evalJs(`JSON.stringify({
  path: document.getElementById("path").value,
  okText: document.getElementById("ok").textContent,
  okDisabled: document.getElementById("ok").disabled,
  note: document.getElementById("note").textContent,
  upgradeShown: document.getElementById("upgradeLine").style.display,
})`);
console.log("STATE:", state);

if (mode === "state") process.exit(0);

if (mode === "setdir" && customDir) {
  await evalJs(`document.getElementById("path").value = ${JSON.stringify(customDir)}; true`);
  console.log("setdir done:", await evalJs(`document.getElementById("path").value`));
  process.exit(0);
}

if (mode === "install") {
  await evalJs(`document.getElementById("ok").click(); true`);
  // wait for done (button flips to 关闭)
  let done = null;
  for (let i = 0; i < 45; i++) {
    await sleep(1000);
    done = await evalJs(`JSON.stringify({ok: document.getElementById("ok").textContent, note: document.getElementById("note").textContent})`);
    const parsed = JSON.parse(done);
    if (parsed.ok === "关闭") break;
  }
  console.log("DONE:", done);
  // click 关闭 → app launch + window close
  await evalJs(`document.getElementById("ok").click(); true`);
  await sleep(1500);
  process.exit(0);
}
process.exit(0);
