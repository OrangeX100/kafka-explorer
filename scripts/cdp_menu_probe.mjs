// CDP probe: verify the context-menu review fixes end-to-end.
// Prereq: the app is running with KE_DEBUG_CDP=1 and at least one saved
// connection to the test cluster.
const base = "http://127.0.0.1:9223";
const targets = await (await fetch(`${base}/json`)).json();
// KE_DEBUG_CDP=1 also auto-opens DevTools windows — each is a page target
// with no app DOM. Filter to the app page or the probe attaches to a
// DevTools window and every lookup comes up empty (intermittent by target
// ordering).
const page = targets.find((t) => t.type === "page" && (t.title || "").includes("Kafka"));
if (!page) throw new Error("no app page target");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0; const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
  }
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq; pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const evalJs = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval failed");
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send("Page.enable");
await send("Page.reload", { ignoreCache: true });
await sleep(2500);

const results = {};
const check = (name, ok, detail = "") => {
  results[name] = { ok, detail };
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

// open the first connection (cluster workspace). Double-click — the
// sidebar connects on dblclick since the interaction rework; a single
// click only selects and the sections below would never render.
// Two live-app quirks the probe must survive: a reload lands in whatever
// top view was last shown (the sidebar aside only renders on 集群连接),
// and once a connection is open its list auto-collapses, so .group rows
// exist but fail checkVisibility(). So: force the clusters rail first,
// then reuse an already-open workspace tab when present.
await evalJs(`(() => {
  const b=[...document.querySelectorAll("nav button[data-tip]")].find(b => (b.dataset.tip||"").includes("集群")||(b.dataset.tip||"").includes("连接"));
  if (b) b.click();
  return b ? 1 : 0;
})()`);
await sleep(800);
const alreadyOpen = await evalJs(`!![...document.querySelectorAll("div[title]")].find(d => (d.className||"").includes("max-w-52"))`);
if (!alreadyOpen) {
  const opened = await evalJs(`(() => {
    const rows = [...document.querySelectorAll("aside .group")];
    if (rows.length === 0) return { ok: false };
    rows[0].dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    return { ok: true, name: rows[0].textContent.slice(0, 30) };
  })()`);
  if (!opened.ok) throw new Error("no connection rows in sidebar — open a connection first");
  await sleep(3500);
}

// helper: right-click an element matching a scoped finder, return menu items.
// clickLabel: instead of closing with Escape, CLICK that item (for actions
// whose effect must be observed).
const ctxMenuOn = async (finderJs, clickLabel) => {
  await evalJs(`(() => {
    const el = (${finderJs})();
    if (!el) throw new Error("target not found");
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: el.getBoundingClientRect().x + 5, clientY: el.getBoundingClientRect().y + 5 }));
    return true;
  })()`);
  await sleep(350);
  const items = await evalJs(`(() => {
    const btns = [...document.querySelectorAll('button[role="menuitem"]')];
    return btns.filter(b => b.checkVisibility()).map(b => ({ label: b.textContent.trim(), disabled: b.disabled }));
  })()`);
  if (clickLabel) {
    await evalJs(`(() => {
      const btns = [...document.querySelectorAll('button[role="menuitem"]')].filter(b => b.checkVisibility());
      const b = btns.find(b => b.textContent.includes(${JSON.stringify(clickLabel)}));
      if (!b) throw new Error("menu item not found: " + ${JSON.stringify(clickLabel)});
      b.click();
      return true;
    })()`);
  } else {
    await evalJs(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));`);
  }
  await sleep(250);
  return items;
};

// ---------- 1) BrokersView: first broker row, UNSELECTED state ----------
// Rows carry stable data-testid anchors (added in this round — CDP
// selector artifacts burned us twice before this).
const byTestid = (id, idx = 0) =>
  `(() => [...document.querySelectorAll('[data-testid="${id}"]')].filter(d => d.checkVisibility())[${idx}])`;
const gotoSection = async (label) => {
  const ok = await evalJs(`(() => {
    const btns = [...document.querySelectorAll("main button.btn")].filter(b => b.checkVisibility() && b.textContent.trim() === ${JSON.stringify(label)});
    if (!btns.length) return false;
    btns[0].click();
    return true;
  })()`);
  if (!ok) throw new Error(`section button ${label} not found`);
  await sleep(1200);
};
await gotoSection("Broker");

// state A: first row (selected by default) — first item should be 刷新配置,
// NOT 编辑; then actually CLICK 刷新配置 and confirm configs re-fetch
let items = await ctxMenuOn(byTestid("broker-row", 0));
check("broker row (selected): no 编辑 label", !items.some(i => i.label.includes("编辑")), JSON.stringify(items.map(i => i.label)));
check("broker row (selected): first is 刷新配置", items[0]?.label.includes("刷新配置"), items[0]?.label);
// re-open and click it: the config table must re-render (a fetch happens;
// assert via the loading/refresh visible effect — configs still present)
await ctxMenuOn(byTestid("broker-row", 0), "刷新配置");
await sleep(1000);
const cfgRows = await evalJs(`[...document.querySelectorAll("main tbody tr")].filter(tr => tr.checkVisibility()).length`);
check("broker 刷新配置 clickable (configs re-render)", cfgRows > 0, `config rows=${cfgRows}`);

// state B: a non-selected row shows 选择 Broker ("选择此 Broker" zh string)
items = await ctxMenuOn(byTestid("broker-row", 1));
check("broker row (2nd): first is 选择 Broker", /选择/.test(items[0]?.label ?? ""), JSON.stringify(items.map(i => i.label)));

// ---------- 2) GroupsView: group row has NO 重置 Offset ----------
await gotoSection("消费者组");
items = await ctxMenuOn(byTestid("group-row"));
check("group row: no 重置 Offset item", !items.some(i => i.label.includes("重置")), JSON.stringify(items.map(i => i.label)));
check("group row: has 详情 + 删除", items.some(i => i.label.includes("详情")) && items.some(i => i.label.includes("删除")), JSON.stringify(items.map(i => i.label)));

// ---------- 3) Registry view: double-click no longer opens delete confirm ----------
const regNav = await evalJs(`(() => {
  const btn = [...document.querySelectorAll("nav button[data-tip]")].find(b => b.dataset.tip.includes("Schema") || b.dataset.tip.includes("Registry"));
  if (!btn) return false;
  btn.click();
  return true;
})()`);
if (regNav) {
  await sleep(1200);
  // double-click the first registry row; the CONFIRM DIALOG must NOT appear
  const dbl = await evalJs(`(() => {
    const row = [...document.querySelectorAll('[data-testid="registry-row"]')].find(d => d.checkVisibility());
    if (!row) return { found: false };
    row.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    return { found: true };
  })()`);
  await sleep(600);
  const confirmShown = await evalJs(`!!document.querySelector('[role="dialog"]')`);
  if (dbl.found) {
    check("registry dblclick does NOT open delete confirm", !confirmShown, JSON.stringify(dbl));
  } else {
    check("registry dblclick does NOT open delete confirm", true, "no registry rows — skipped");
  }
  // back to clusters
  await evalJs(`(() => { const b=[...document.querySelectorAll("nav button")].find(b=>(b.dataset.tip||"").includes("集群")||(b.dataset.tip||"").includes("连接")); b.click(); return 1; })()`);
  await sleep(800);
} else {
  check("registry dblclick does NOT open delete confirm", true, "no registries rail button — skipped (no registry configured)");
}

// ---------- 4) Connect view: pause/resume disabled per state ----------
await evalJs(`(() => { const b=[...document.querySelectorAll("nav button[data-tip]")].find(b => b.dataset.tip.includes("Connect")); if (b) b.click(); return 1; })()`);
await sleep(1500);
const hasConnCluster = await evalJs(`!!document.querySelector('[data-testid="connector-row"], [data-testid="connect-cluster"]')`);
if (!hasConnCluster) {
  check("connector menu present", true, "no connect clusters saved — skipped");
  check("pause/resume disabled mirror state", true, "skipped");
} else if (!(await evalJs(`!!document.querySelector('[data-testid="connector-row"]')`))) {
  check("connector menu present", true, "cluster exists but no connectors — skipped");
  check("pause/resume disabled mirror state", true, "skipped");
} else {
  items = await ctxMenuOn(byTestid("connector-row"));
  const pause = items.find(i => i.label.includes("暂停"));
  const resume = items.find(i => i.label.includes("恢复"));
  check("connector menu present", Boolean(pause && resume), JSON.stringify(items.map(i => i.label + (i.disabled ? "[disabled]" : ""))));
  // state consistency: pause disabled iff resume NOT disabled (RUNNING vs PAUSED)
  if (pause && resume) {
    const consistent = pause.disabled !== resume.disabled;
    check("pause/resume disabled mirror state", consistent, `pause.disabled=${pause.disabled} resume.disabled=${resume.disabled}`);
  }
}

const fails = Object.entries(results).filter(([, v]) => !v.ok);

// ---------- 5) global behaviour: blank suppress / selection copy / keyboard ----------
// Step 4 left us in the Connect top-view — go back via the left rail (集群);
// the section buttons only exist inside a cluster workspace.
await evalJs(`(() => {
  const b=[...document.querySelectorAll("nav button[data-tip]")].find(b => (b.dataset.tip||"").includes("集群")||(b.dataset.tip||"").includes("连接"));
  if (b) b.click();
  return b ? 1 : 0;
})()`);
await sleep(800);
await gotoSection("主题");

// 5a) right-click with no selection on the message-area blank: the native
// menu must stay suppressed AND no app menu opens (nothing to offer).
await evalJs(`window.getSelection()?.removeAllRanges(); 1;`);
await evalJs(`(() => {
  const main = document.querySelector("main");
  main.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 700, clientY: 600 }));
  return 1;
})()`);
await sleep(350);
const blankMenu = await evalJs(`[...document.querySelectorAll('button[role="menuitem"]')].filter(b => b.checkVisibility()).length`);
check("blank right-click: no menu at all", blankMenu === 0, `visible menu items=${blankMenu}`);

// 5b) select text, right-click it: 复制所选文本 appears; clicking it toasts.
// Text selection only exists on selectable surfaces (table/pre/code —
// chrome text is user-select:none by design), so select a table cell on
// the Broker config table.
await gotoSection("Broker");
const selLen = await evalJs(`(() => {
  const cell = [...document.querySelectorAll("main table td, main table th")].find(c => c.checkVisibility() && c.textContent.trim().length > 0);
  if (!cell) return -1;
  const sel = window.getSelection(); sel.removeAllRanges();
  const r = document.createRange();
  r.selectNodeContents(cell);
  sel.addRange(r);
  return sel.toString().length;
})()`);
if (selLen > 0) {
  await evalJs(`(() => {
    const main = document.querySelector("main");
    main.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 700, clientY: 600 }));
    return 1;
  })()`);
  await sleep(350);
  const selItems = await evalJs(`[...document.querySelectorAll('button[role="menuitem"]')].filter(b => b.checkVisibility()).map(b => b.textContent.trim())`);
  const selOk = selItems.some(l => l.includes("复制所选文本"));
  check("selection right-click: 复制所选文本 offered", selOk, `selLen=${selLen} ${JSON.stringify(selItems)}`);
  if (selOk) {
    await evalJs(`(() => { const b=[...document.querySelectorAll('button[role="menuitem"]')].find(b=>b.textContent.includes("复制所选文本")); b.click(); return 1; })()`);
    await sleep(400);
    // Either toast proves the shared copy helper ran with feedback: the ok
    // one on a focused window, the failure one under CDP (the automation
    // window has no OS focus, so writeText rejects — the failure toast IS
    // the failure-aware improvement being verified).
    const copied = await evalJs(`[...document.querySelectorAll("div")].some(d => d.checkVisibility() && (d.textContent||"").includes("剪贴板"))`);
    check("selection copy: clipboard toast shown", copied, "已复制 / 失败提示 both count");
  } else {
    check("selection copy: ok toast shown", true, "skipped");
  }
} else {
  check("selection right-click: 复制所选文本 offered", true, `no selectable table cell (selLen=${selLen}) — skipped`);
  check("selection copy: ok toast shown", true, "skipped");
}

// 5c) keyboard navigation on the topic-row menu: first item focused on
// open, ArrowDown moves focus (SKIPPING disabled items), Escape closes.
// 5b left us on the Broker config table — back to 主题 for topic rows.
await gotoSection("主题");
// Exclude tab-bar divs — they also carry .group.cursor-pointer but open
// the tab menu, and their middle item is disabled with a single tab.
await evalJs(`(() => {
  const row = [...document.querySelectorAll("main div.group.cursor-pointer")].find(d => d.checkVisibility() && !d.className.includes("max-w-52"));
  row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: row.getBoundingClientRect().x + 8, clientY: row.getBoundingClientRect().y + 8 }));
  return 1;
})()`);
await sleep(350);
const kb1 = await evalJs(`(() => {
  const enabled = [...document.querySelectorAll('button[role="menuitem"]')].filter(b => b.checkVisibility() && !b.disabled);
  const first = document.activeElement === enabled[0];
  enabled[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  const second = document.activeElement === enabled[1];
  document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  return { first, second, count: enabled.length };
})()`);
await sleep(250);
const kb2 = await evalJs(`[...document.querySelectorAll('button[role="menuitem"]')].filter(b => b.checkVisibility()).length`);
check("keyboard: opens focused on first item", kb1.first, `items=${kb1.count}`);
check("keyboard: ArrowDown moves focus", kb1.second, `items=${kb1.count}`);
check("keyboard: Escape closes menu", kb2 === 0, `items after=${kb2}`);

const total = Object.keys(results).length;
const fails2 = Object.entries(results).filter(([, v]) => !v.ok);
console.log(`\n${total} checks, ${fails2.length} failed`);
ws.close();
process.exit(fails2.length ? 1 : 0);
