#!/usr/bin/env node
// audit-i18n: every locale must contain exactly the same key set as the
// base locale (zh-CN). Missing keys blank the UI; extra keys rot and mislead
// translators. Both directions fail the audit.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const localesDir = join(here, "..", "src", "shared", "locales");
const base = "zh-CN";
const locales = ["zh-CN", "en"];

function loadKeys(locale) {
  const data = JSON.parse(readFileSync(join(localesDir, `${locale}.json`), "utf8"));
  return new Set(Object.keys(data));
}

const problems = [];
const baseKeys = loadKeys(base);
for (const locale of locales.filter((l) => l !== base)) {
  const keys = loadKeys(locale);
  for (const k of baseKeys) {
    if (!keys.has(k)) problems.push(`${locale}.json: missing key "${k}"`);
  }
  for (const k of keys) {
    if (!baseKeys.has(k)) problems.push(`${locale}.json: extra key "${k}" (not in ${base}.json)`);
  }
}

if (problems.length > 0) {
  console.error(`audit-i18n: ${problems.length} problem(s)`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`audit-i18n: ok (${locales.length} locales, ${baseKeys.size} keys)`);
