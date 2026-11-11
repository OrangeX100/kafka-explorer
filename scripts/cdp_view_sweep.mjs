// cdp_view_sweep: click through EVERY view/section/tab branch and assert the
// app stays alive (a React crash unmounts the tree → white screen). Catches
// the runtime-crash class static review misses, e.g. the consumer-group
// members tab white screen (nil slice → JSON null → .length throw).
const base = "http://127.0.0.1:9223";
const targets = await (await fetch(`${base}/json`)).json();
const page = targets.find(t => t.type === "page" && (t.title || "").includes("Kafka"));
if (!page) throw new Error("no app page target");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0; const pending = new Map();
ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } };
const send = (m, p = {}) => new Promise((r, j) => { const id = ++seq; pending.set(id, { resolve: r, reject: j }); ws.send(JSON.stringify({ id, method: m, params: p })); });
const evalJs = async (e) => { const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval failed"); return r.result.value; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

await send("Page.enable");
await send("Page.reload", { ignoreCache: true });
await sleep(3000);
// collect uncaught errors from the page itself
await evalJs(`window.__errs = []; window.addEventListener("error", e => window.__errs.push(String(e.message).slice(0, 200))); 1;`);

const steps = [];
const step = async (name, js, wait = 1200) => {
  const errsBefore = await evalJs(`window.__errs.length`);
  let ok = false, detail = "";
  try {
    detail = String(await evalJs(js));
    await sleep(wait);
    const alive = await evalJs(`// small views (empty ACL/quota lists) legitimately render <100 chars
    !!document.querySelector("main") && document.body.textContent.length > 40`);
    const errsNow = await evalJs(`window.__errs.length`);
    ok = alive && errsNow === errsBefore;
    if (!alive) detail += " [TREE UNMOUNTED]";
    if (errsNow !== errsBefore) {
      const newErrs = await evalJs(`window.__errs.slice(${errsBefore})`);
      detail += " [ERRS] " + newErrs.join(" | ");
    }
  } catch (e) {
    detail = "EVAL-FAIL " + String(e.message).slice(0, 150);
  }
  steps.push({ name, ok, detail: detail.slice(0, 200) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? "  — " + detail.slice(0, 160) : ""}`);
};

const findBtn = (label) => `[...document.querySelectorAll("main button")].find(b => b.checkVisibility() && b.textContent.trim() === ${JSON.stringify(label)})?.click(); "clicked"`;
const findBtnIncludes = (label) => `[...document.querySelectorAll("main button")].find(b => b.checkVisibility() && b.textContent.includes(${JSON.stringify(label)}))?.click(); "clicked"`;
const railNav = (tip) => `[...document.querySelectorAll("nav button[data-tip]")].find(b => (b.dataset.tip||"").includes(${JSON.stringify(tip)}))?.click(); "nav"`;

// ---- cluster workspace ----
await evalJs(`(() => { const b=[...document.querySelectorAll("nav button[data-tip]")].find(b => (b.dataset.tip||"").includes("集群")); b?.click(); return 1; })()`);
await sleep(800);
const hasTab = await evalJs(`!![...document.querySelectorAll("div[title]")].find(d => (d.className||"").includes("max-w-52"))`);
if (!hasTab) {
  await evalJs(`(() => { const r=[...document.querySelectorAll("aside .group")][0]; r?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); return 1; })()`);
  await sleep(3500);
}

// 7 cluster sections
await step("section 主题", findBtn("主题"));
await step("section 消费者组", findBtn("消费者组"));
await step("section Share 组", findBtn("Share 组"));
await step("section Broker", findBtn("Broker"));
await step("section ACL", findBtn("ACL"));
await step("section 配额", findBtn("配额"));
await step("section 对比", findBtn("对比"));

// topic sub-views (open the first topic row)
await step("back to 主题", findBtn("主题"));
await step("topic open", `(() => { const r=[...document.querySelectorAll("main div.group.cursor-pointer")].find(d => d.checkVisibility() && !d.className.includes("max-w-52")); r?.click(); return r ? "opened" : "no-row"; })()`, 3000);
await step("topic tab 消息", findBtn("消息"));
await step("topic tab 配置", findBtnIncludes("配置") /* matches 配置 nav + others, first visible wins */, 1500);
await step("topic tab 可视化", findBtn("可视化"));
await step("topic tab 消息 again", findBtn("消息"));

// consumer group detail: offsets AND members tabs (the white-screen regression)
await step("section 消费者组 (2)", findBtn("消费者组"));
await step("group open", `(() => { const r=[...document.querySelectorAll("main div.group.cursor-pointer")].find(d => d.checkVisibility() && !d.className.includes("max-w-52")); r?.click(); return r ? "opened" : "no-row"; })()`, 2500);
await step("group tab 成员", findBtnIncludes("成员"), 1500);
await step("group tab 偏移", findBtnIncludes("偏移"), 1000);

// share group detail tabs
await step("section Share 组 (2)", findBtn("Share 组"));
await step("share open", `(() => { const r=[...document.querySelectorAll("main div.group.cursor-pointer")].find(d => d.checkVisibility() && !d.className.includes("max-w-52")); r?.click(); return r ? "opened" : "no-row"; })()`, 2500);
await step("share tab 成员", findBtnIncludes("成员"), 1500);

// broker detail row click (config table)
await step("section Broker (2)", findBtn("Broker"));
await step("broker row click", `(() => { const r=[...document.querySelectorAll('main [data-testid="broker-row"]')].find(d => d.checkVisibility()); r?.click(); return r ? "clicked" : "no-row"; })()`, 2000);

// top views
await step("top Registry", railNav("Schema"));
await step("top Connect", railNav("Connect"));
await step("top Settings", railNav("设置"));
await step("top clusters back", railNav("集群"));

const fails = steps.filter(s => !s.ok);
console.log(`\n${steps.length} steps, ${fails.length} failed`);
if (fails.length) console.log(JSON.stringify(fails, null, 1));
ws.close();
process.exit(fails.length ? 1 : 0);
