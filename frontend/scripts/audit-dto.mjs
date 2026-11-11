#!/usr/bin/env node
// audit-dto: hand-written contracts (src/shared/contracts.ts) must stay in
// sync with the wails-generated models (bindings/.../models.js, JSDoc
// typedefs). The generated files are gitignored, so drift would otherwise
// surface only at runtime as undefined fields — this audit makes it a red
// build instead.
//
// Method: extract @typedef blocks (name + property lines) from generated
// domain/application/wails models, extract interfaces from contracts.ts,
// compare property-name sets per type name.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const frontendRoot = join(here, "..");
const bindingsRoot = join(frontendRoot, "bindings", "kafkaexplorer");
const contractsPath = join(frontendRoot, "src", "shared", "contracts.ts");

if (!existsSync(bindingsRoot)) {
  console.error("audit-dto: bindings not generated yet — run `task generate:bindings` first");
  process.exit(2);
}

function* walk(dir) {
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (e.endsWith(".js") || e.endsWith(".d.ts")) yield full;
  }
}

// --- generated side: JSDoc typedefs ---
const generated = new Map(); // typeName -> Set(properties)
const typedefRe = /@typedef \{[^}]+\} (\w+)/;
// The type expression may contain nested braces ({{[key: string]: X | null}});
// greedy `.+` matches up to the LAST closing brace before the property name.
const propertyRe = /@property \{.+\} (\[?)(\w+)/;

for (const file of walk(bindingsRoot)) {
  const text = readFileSync(file, "utf8");
  const blocks = text.split("/**").slice(1);
  for (const block of blocks) {
    const nameMatch = block.match(typedefRe);
    if (!nameMatch) continue;
    const typeName = nameMatch[1];
    const props = new Set();
    for (const line of block.split("\n")) {
      const m = line.match(propertyRe);
      if (m) props.add(m[2]);
    }
    if (props.size > 0) {
      const existing = generated.get(typeName) ?? new Set();
      for (const p of props) existing.add(p);
      generated.set(typeName, existing);
    }
  }
}

// --- contracts side: TS interfaces ---
const contracts = new Map();
const contractText = readFileSync(contractsPath, "utf8");
const ifaceRe = /export interface (\w+)[^{]*\{([^}]*)\}/g;
let m;
while ((m = ifaceRe.exec(contractText)) !== null) {
  const [, name, body] = m;
  const props = new Set();
  for (const line of body.split("\n")) {
    const propMatch = line.match(/^\s*(\w+)\??:/);
    if (propMatch) props.add(propMatch[1]);
  }
  contracts.set(name, props);
}

// --- compare (one direction is enough to catch drift both ways in practice,
// but we check both so renames must land on both sides in one commit) ---
const problems = [];
for (const [name, props] of contracts) {
  const gen = generated.get(name);
  if (!gen) continue; // pure frontend type, not a DTO
  for (const p of props) {
    if (!gen.has(p)) problems.push(`${name}.${p}: in contracts.ts but missing in generated bindings`);
  }
  for (const p of gen) {
    if (!props.has(p)) problems.push(`${name}.${p}: in generated bindings but missing in contracts.ts`);
  }
}

if (problems.length > 0) {
  console.error(`audit-dto: ${problems.length} problem(s) between contracts.ts and generated bindings`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
const matched = [...contracts.keys()].filter((n) => generated.has(n)).length;
console.log(`audit-dto: ok (${matched} DTO types in sync)`);
