// audit-used-keys: every LITERAL t("...") key used in source must exist in
// the locale files. The existing audit-i18n checks zh/en PARITY, which
// cannot catch "key missing from BOTH locales" — parity holds while the UI
// renders raw key names (shipped 3×: common.delete, tray.hint,
// conn.cloneHint). This scan closes that hole.
// Dynamic keys (t(`family.${v}`)) are whitelisted by their static prefix.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const LOCALES = ["zh-CN", "en"];

const locales = {};
for (const name of LOCALES) {
  locales[name] = JSON.parse(
    readFileSync(new URL(`../src/shared/locales/${name}.json`, import.meta.url), "utf-8"),
  );
}

// 1) parity (audit-i18n covers this; re-assert so one script = one verdict)
const zhKeys = new Set(Object.keys(locales["zh-CN"]));
const enKeys = new Set(Object.keys(locales["en"]));
let broken = false;
const zhOnly = [...zhKeys].filter((k) => !enKeys.has(k));
const enOnly = [...enKeys].filter((k) => !zhKeys.has(k));
if (zhOnly.length || enOnly.length) {
  broken = true;
  console.log("PARITY BROKEN:");
  if (zhOnly.length) console.log("  zh only:", zhOnly.slice(0, 10));
  if (enOnly.length) console.log("  en only:", enOnly.slice(0, 10));
}

// 2) walk source files for literal t("...") keys
function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

const files = walk(SRC);
const literalPat = /(?<![\w])t\(\s*(['"])([A-Za-z0-9_.-]+)\1/g;
const dynPat = /t\(\s*`([A-Za-z0-9_.-]+)\$\{/g;

const used = new Set();
const dynPrefixes = new Set();
for (const f of files) {
  const text = readFileSync(f, "utf-8");
  for (const m of text.matchAll(literalPat)) used.add(m[2]);
  for (const m of text.matchAll(dynPat)) dynPrefixes.add(m[1]);
}

// dynamic families: a used dynamic key passes if its prefix family exists
function familyExists(key) {
  for (const p of dynPrefixes) {
    if (key.startsWith(p)) {
      const rest = key.slice(p.length);
      if (!rest.includes("`")) return true;
    }
  }
  return false;
}

const missing = [...used].filter((k) => {
  if (zhKeys.has(k) && enKeys.has(k)) return false;
  // dynamic families are checked against zh; en parity was asserted above
  if ((!zhKeys.has(k) || !enKeys.has(k)) && familyExists(k)) return false;
  return true;
});

console.log(`audit-used-keys: ${files.length} files, ${used.size} literal keys, ${dynPrefixes.size} dynamic families`);
if (missing.length) {
  broken = true;
  console.log(`MISSING FROM LOCALES (${missing.length}):`);
  for (const k of missing) console.log("  " + k);
}
if (broken) {
  console.log("audit-used-keys: FAIL");
  process.exit(1);
}
console.log("audit-used-keys: ok");
