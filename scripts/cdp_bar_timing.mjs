// sample bar width during an upgrade install: must sweep >= MIN_RUNTIME
const base = "http://127.0.0.1:9225";
const targets = await (await fetch(`${base}/json`)).json();
const page = targets.find((t) => t.type === "page" && t.url === "http://wails.localhost/");
if (!page) { console.log("ERR: no page"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } };
const send = (m, p = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method: m, params: p })); });
const evalJs = async (e) => { const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval"); return r.result.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await evalJs('document.getElementById("path").value = ' + JSON.stringify("D:\\Kafka Explorer") + '; true');
// wait for the button to enable (loadInfo may still be in flight)
for (let i = 0; i < 20; i++) {
  const st = JSON.parse(await evalJs('JSON.stringify({d: document.getElementById("ok").disabled})'));
  if (!st.d) break;
  await sleep(300);
}
const t0 = Date.now();
await evalJs(`document.getElementById("ok").click(); true`);
const samples = [];
for (let i = 0; i < 30; i++) {
  await sleep(300);
  const s = await evalJs(`JSON.stringify({w: document.getElementById("bar").style.width, ok: document.getElementById("ok").textContent, visible: document.getElementById("progress").style.display})`).catch(() => null);
  if (!s) break;
  samples.push(((Date.now() - t0) / 1000).toFixed(1) + "s " + s);
  if (JSON.parse(s).ok !== "正在安装…") break;
}
console.log(samples.join("\n"));
process.exit(0);
