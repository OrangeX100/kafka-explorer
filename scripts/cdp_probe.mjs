// CDP probe: drive the running app's WebView2 (port 9223) to verify the
// new settings page end-to-end. Usage: node scripts/cdp_probe.mjs
const base = "http://127.0.0.1:9223";

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

// fresh load so the new bundle is authoritative
await send("Page.enable");
await send("Page.reload", { ignoreCache: true });
await new Promise((r) => setTimeout(r, 2500));

// navigate to the settings view via the rail button (data-tip = 设置/Settings)
const gotoSettings = () =>
  evalJs(`(() => {
    const btn = [...document.querySelectorAll("nav button")].find(b => (b.dataset.tip || "").includes("设置") || (b.dataset.tip || "").includes("Settings"));
    btn.click();
    return true;
  })()`);
await gotoSettings();
await new Promise((r) => setTimeout(r, 800));

const results = {};
const check = (name, ok, detail = "") => {
  results[name] = { ok, detail };
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

// 1) four sections render
const sections = await evalJs(`(() => {
  const panels = [...document.querySelectorAll("section.panel")];
  return {
    count: panels.length,
    titles: [...document.querySelectorAll("h2")].map(h => h.textContent),
    sectionHeads: panels.map(p => p.querySelector(".text-11.font-medium")?.textContent),
  };
})()`);
check("four sections", sections.count === 4, JSON.stringify(sections.sectionHeads));

// 2) preview panel exists
const preview = await evalJs(`!!document.querySelector('[data-testid="settings-preview"]')`);
check("preview panel", preview);

// locate a settings control by its row label text (labels are localized)
const controlByLabel = (labelPart) =>
  evalJs(`(() => {
    const row = [...document.querySelectorAll("section.panel .space-y-2\\.5 > div")].find(d => d.textContent.includes(${JSON.stringify(labelPart)}));
    if (!row) return null;
    return row.querySelector("select, input");
  })()`);

const setSelectByLabel = async (labelPart, value) => {
  const hit = await evalJs(`(() => {
    const rows = [...document.querySelectorAll("section.panel div")].filter(d => d.children.length === 2 && d.textContent.includes(${JSON.stringify(labelPart)}));
    const row = rows[rows.length - 1];
    if (!row) return false;
    const sel = row.querySelector("select");
    if (!sel) return false;
    sel.value = ${JSON.stringify(value)};
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);
  if (!hit) throw new Error(`control not found for label ${labelPart}`);
};

// 3) lineHeight select -> root var + preview reflow (live)
await setSelectByLabel("行高", "1.2");
await new Promise((r) => setTimeout(r, 200));
const lhApplied = await evalJs(`document.documentElement.style.getPropertyValue("--app-line-height")`);
check("lineHeight live var", lhApplied === "1.2", `--app-line-height=${lhApplied}`);
await setSelectByLabel("行高", "1.5");

// 4) fontFamily select -> root var
await setSelectByLabel("界面字体", "simSun");
await new Promise((r) => setTimeout(r, 200));
const ffVar = await evalJs(`document.documentElement.style.getPropertyValue("--app-font")`);
check("fontFamily live var", (ffVar || "").includes("SimSun"), ffVar?.slice(0, 60));
await setSelectByLabel("界面字体", "");

// 5) about section: version/commit/goos populated via binding
const about = await evalJs(`(() => {
  const mono = [...document.querySelectorAll("span.font-mono")].map(e => e.textContent);
  const rows = [...document.querySelectorAll("dl > div")].map(d => d.textContent);
  return { versionChip: mono.find(m => m.startsWith("v")), rows };
})()`);
check("about version chip", about.versionChip === "v0.1.0-dev", about.versionChip);
const rowsStr = JSON.stringify(about.rows);
check("about go/platform rows", rowsStr.includes("go1.") && rowsStr.includes("windows/amd64"), rowsStr.slice(0, 200));
check("about paths", rowsStr.includes("KafkaExplorer") && rowsStr.includes("kafka-explorer.log"), "");

// 6) update check: empty repo -> button disabled
const disabled = await evalJs(`(() => {
  const btns = [...document.querySelectorAll("button.btn-accent")];
  const b = btns.find(b => b.textContent.includes("检查更新") || b.textContent.includes("Check"));
  return { found: !!b, disabled: b?.disabled };
})()`);
check("check button disabled when repo empty", disabled.found && disabled.disabled === true, JSON.stringify(disabled));

// 7) update check against a real repo (network-dependent): fill golang/go and click
// React controlled inputs need the native value setter, otherwise the
// valueTracker swallows the programmatic write and onChange never fires.
await evalJs(`(() => {
  const inp = [...document.querySelectorAll("input.font-mono")].find(i => i.placeholder.includes("owner/repo") || i.placeholder.includes("kafka-tools"));
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(inp, "golang/go");
  inp.dispatchEvent(new Event("input", { bubbles: true }));
  return inp.value;
})()`);
await evalJs(`(() => {
  const btns = [...document.querySelectorAll("button.btn-accent")];
  const b = btns.find(b => b.textContent.includes("检查更新") || b.textContent.includes("Check"));
  b.click();
  return { disabled: b.disabled };
})()`);
await new Promise((r) => setTimeout(r, 12000));
const upd = await evalJs(`(() => {
  const el = document.querySelector('[data-testid="update-result"]');
  if (el) return { result: el.textContent.slice(0, 220), error: null };
  const err = [...document.querySelectorAll("div[class*='border-danger']")].map(d => d.textContent)[0] || null;
  return { result: null, error: err };
})()`);
if (upd.result) {
  const ok = upd.result.includes("发现新版本") || upd.result.includes("New version") || upd.result.includes("最新版本");
  check("update check ran (real repo)", ok, upd.result.slice(0, 140));
} else {
  check("update check friendly error", upd.error && !/RuntimeError|tcp dial|connectex/.test(upd.error), (upd.error || "").slice(0, 140));
}

// 8) save round-trip: lineHeight 1.6 persists (boot re-applies from server)
await setSelectByLabel("行高", "1.6");
await evalJs(`(() => {
  const btn=[...document.querySelectorAll("button.btn-accent")].find(b=>b.textContent.includes("保存")||b.textContent.includes("Save"));
  btn.click(); return 1;
})()`);
await new Promise((r) => setTimeout(r, 1500));
// re-read via UI: reload lands on clusters view -> navigate back to settings
await send("Page.reload", { ignoreCache: true });
await new Promise((r) => setTimeout(r, 2500));
await gotoSettings();
await new Promise((r) => setTimeout(r, 800));
const lhAfter = await evalJs(`(() => {
  const rows = [...document.querySelectorAll("section.panel div")].filter(d => d.children.length === 2 && d.textContent.includes("行高"));
  const sel = rows[rows.length - 1]?.querySelector("select");
  return { value: sel?.value, rootVar: document.documentElement.style.getPropertyValue("--app-line-height") };
})()`);
check("lineHeight persisted after save+reload", lhAfter.value === "1.6" && lhAfter.rootVar === "1.6", JSON.stringify(lhAfter));
// restore default
await setSelectByLabel("行高", "1.5");
await evalJs(`(() => {
  const btn=[...document.querySelectorAll("button.btn-accent")].find(b=>b.textContent.includes("保存")||b.textContent.includes("Save"));
  btn.click(); return 1;
})()`);
await new Promise((r) => setTimeout(r, 1200));

// 9) titlebar icon (new transparent glyph) renders
const icon = await evalJs(`(() => {
  const img = document.querySelector('img[src="/appicon.png"]');
  return { loaded: img?.complete && img?.naturalWidth > 0, w: img?.naturalWidth };
})()`);
check("titlebar appicon loaded", icon.loaded === true, JSON.stringify(icon));

// screenshot of settings page for the record
const shot = await send("Page.captureScreenshot", { format: "png" });
const fs = await import("node:fs");
fs.writeFileSync("build/preview/settings-page.png", Buffer.from(shot.data, "base64"));

const fails = Object.entries(results).filter(([, v]) => !v.ok);
console.log(`\n${results.length ? Object.keys(results).length : 0} checks, ${fails.length} failed`);
ws.close();
process.exit(fails.length ? 1 : 0);
