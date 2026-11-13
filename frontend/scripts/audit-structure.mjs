#!/usr/bin/env node
// audit-structure: file line budgets per area. The point is not small files;
// it is forcing "split it" to become a conscious decision (register an
// exemption with a reason) instead of a silent slide.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

// Budgets are per file, by area.
const LIMITS = [
  { dir: "src/features", maxLines: 400 },
  { dir: "src/shared", maxLines: 350 },
  { dir: "src/state", maxLines: 150 },
];
// Historical large files registered deliberately. New files never go here
// without a reason — these five grew past budget with the 0.4.0 feature
// wave (SSH tunnel UI, task restart + config edit, compat workbench, the
// manifest/API plumbing); splitting them is planned for 0.5.x, and until
// then the overage is a registered decision, not a silent slide.
const EXEMPT = new Set([
  "src/features/admin/ConnectDialogs.tsx",
  "src/features/connections/ConnectionDialog.tsx",
  "src/features/shell/Sidebar.tsx",
  "src/shared/api.ts",
  "src/shared/contracts-admin.ts",
]);

function* walk(dir) {
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (e.endsWith(".ts") || e.endsWith(".tsx")) yield full;
  }
}

const problems = [];
let checked = 0;
for (const { dir, maxLines } of LIMITS) {
  const abs = join(root, dir);
  if (!existsSync(abs)) continue;
  for (const file of walk(abs)) {
    checked++;
    const rel = relative(root, file).replaceAll("\\", "/");
    if (EXEMPT.has(rel)) continue;
    const lines = readFileSync(file, "utf8").split("\n").length;
    if (lines > maxLines) {
      problems.push(`${rel}: ${lines} lines (budget ${maxLines}; split or register an exemption)`);
    }
  }
}

if (problems.length > 0) {
  console.error(`audit-structure: ${problems.length} problem(s)`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`audit-structure: ok (${checked} files within budget)`);
