// Capture README product screenshots: connects the running app
// (KE_DEBUG_CDP=1) to the demo cluster, opens key views, saves dark-theme
// PNGs into images/.
// Usage: node scripts/cdp_readme_shots.mjs
import fs from "node:fs";

const base = "http://127.0.0.1:9223";
const targets = await (await fetch(`${base}/json`)).json();
const page = targets.find((t) => t.type === "page" && t.url === "http://wails.localhost/");
if (!page) { console.log("ERR: no app page"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } };
const send = (m, p = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method: m, params: p })); });
const evalJs = async (e) => { const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval"); return r.result.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync("images", { recursive: true });

// real input click: find the visible element by text, dispatch actual
// mouse events at its center through CDP Input (the only path that is
// indistinguishable from a user click for every handler shape). mode
// "exact" matches trimmed text equality; "contains" picks the innermost
// element whose text contains the needle (rows carry badge prefixes).
async function realClick(text, dbl = false, mode = "exact") {
  const needle = JSON.stringify(text);
  const cmp = mode === "exact"
    ? `t === ${needle}`
    : `t.includes(${needle})`;
  const rect = JSON.parse(await evalJs(`(() => {
    const els = [...document.querySelectorAll("*")].filter(e =>
      e.checkVisibility?.() === true && (() => {
        const t = (e.textContent || "").trim();
        return ${cmp};
      })());
    if (!els.length) throw new Error("not found: " + ${needle});
    els.sort((a, b) => (a.textContent || "").length - (b.textContent || "").length);
    const el = els[0];
    const r = el.getBoundingClientRect();
    return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
  })()`));
  const opts = { x: rect.x, y: rect.y, clickCount: 1 };
  await send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", ...opts });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", ...opts });
  if (dbl) {
    const opts2 = { x: rect.x, y: rect.y, clickCount: 2 };
    await send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", ...opts2 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", ...opts2 });
  }
}

const clickVisible = (text, dbl = false) => evalJs(`(() => {
  const els = [...document.querySelectorAll("button, [role=button], [role=tab], tr, a, span, div")]
    .filter(b => b.checkVisibility?.() === true && b.textContent.trim() === ${JSON.stringify(text)});
  if (!els.length) throw new Error("not found: " + ${JSON.stringify(text)});
  const el = els[els.length - 1];
  if (${dbl ? "true" : "false"}) {
    // React listens for the real dblclick event — two .click() calls do
    // NOT synthesize one
    el.click();
    el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, view: window, detail: 2 }));
  } else {
    el.click();
  }
  return true;
})()`);

async function shot(name) {
  const s = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(`images/${name}.png`, Buffer.from(s.data, "base64"));
  console.log("saved", name);
}

// 0. dark theme (localStorage store owns it) + reload to apply
await evalJs(`localStorage.setItem("ke.theme", "dark"); true`);
await send("Page.reload", { ignoreCache: true });
await sleep(3000);

// 1. connect: double-click the demo connection row
await realClick("test", true, "contains"); // row text carries the subtitle
await sleep(14000); // metadata + topics load over the public internet
await shot("overview");

// 2. open the first topic → message browser. The topics list is a div
// grid (no <table>): find the leaf holding the topic name and climb to
// the clickable row.
// topics may still be loading over the public internet — retry
let opened = false;
for (let i = 0; i < 5 && !opened; i++) {
  try { await realClick("kafka-explorer-probe", false, "contains"); opened = true; }
  catch { await sleep(4000); }
}
await sleep(5000);
await shot("messages");

// 3. visualization tab ( GlidingTabs — label match on the tab list )
for (const label of ["可视化", "Visualization"]) {
  try { await realClick(label); break; } catch { /* try next locale */ }
}
await sleep(4000); // rate scan
await shot("visualization");

// 4. consumer groups workspace section
for (const label of ["消费者组", "Consumer Groups"]) {
  try { await realClick(label); break; } catch { /* try next locale */ }
}
await sleep(2500);
await shot("groups");
process.exit(0);
