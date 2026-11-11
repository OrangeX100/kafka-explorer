// uninstall flow: options hidden after done + progress events collected
const base = "http://127.0.0.1:9224";
const targets = await (await fetch(`${base}/json`)).json();
const page = targets.find((t) => t.type === "page" && t.url === "http://wails.localhost/");
if (!page) { console.log("ERR: no page"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } };
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
const evalJs = async (expression) => { const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval failed"); return r.result.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await evalJs(`(async () => { const { Events } = await import("/wails/runtime.js"); window.__pcts = []; Events.On("uninstall:progress", (ev) => { if (ev && ev.data && typeof ev.data.pct === "number") window.__pcts.push(ev.data.pct); }); })(); true`);
await evalJs(`document.getElementById("ok").click(); true`);
let done = null;
for (let i = 0; i < 45; i++) {
  await sleep(1000);
  done = await evalJs(`JSON.stringify({
    ok: document.getElementById("ok").textContent,
    note: document.getElementById("note").textContent,
    optionsHidden: document.getElementById("optionsGroup").style.display === "none",
  })`);
  if (JSON.parse(done).ok === "关闭") break;
}
const pcts = await evalJs(`JSON.stringify(window.__pcts)`);
console.log("DONE:", done);
console.log("PROGRESS_EVENTS:", pcts);
await evalJs(`document.getElementById("ok").click(); true`);
await sleep(1500);
process.exit(0);
