// Pure line diff (LCS) for schema comparison — schema comparison
// counterpart. Schemas are small (tens of lines), so the O(n·m) table is
// fine; no external dependency so the registry diff view stays dependency-
// free like the rest of the charts.

export type DiffRow = {
  kind: "same" | "add" | "del";
  text: string;
  /** 1-based line in the A (old) text; undefined for add rows. */
  aLine?: number;
  /** 1-based line in the B (new) text; undefined for del rows. */
  bLine?: number;
};

export function diffLines(a: string, b: string): DiffRow[] {
  const xs = a.length ? a.split("\n") : [];
  const ys = b.length ? b.split("\n") : [];
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  // Walk the LCS backtrack table computed by the helper below.
  const steps = lcsSteps(xs, ys);
  for (const step of steps) {
    if (step === "same") {
      rows.push({ kind: "same", text: xs[i], aLine: i + 1, bLine: j + 1 });
      i++;
      j++;
    } else if (step === "del") {
      rows.push({ kind: "del", text: xs[i], aLine: i + 1 });
      i++;
    } else {
      rows.push({ kind: "add", text: ys[j], bLine: j + 1 });
      j++;
    }
  }
  return rows;
}

// Collapse runs of same-kind rows: a compact view would hide context, but
// counts let the UI badge "N 处变更" without re-walking rows.
export function diffStats(rows: DiffRow[]): { added: number; removed: number; same: number } {
  let added = 0;
  let removed = 0;
  let same = 0;
  for (const r of rows) {
    if (r.kind === "add") added++;
    else if (r.kind === "del") removed++;
    else same++;
  }
  return { added, removed, same };
}

type Step = "same" | "del" | "add";

// Classic DP: table[m+1][n+1] of LCS lengths, then backtrack from (0,0).
function lcsSteps(xs: string[], ys: string[]): Step[] {
  const m = xs.length;
  const n = ys.length;
  const table: Uint32Array = new Uint32Array((m + 1) * (n + 1));
  const at = (r: number, c: number) => r * (n + 1) + c;
  for (let r = m - 1; r >= 0; r--) {
    for (let c = n - 1; c >= 0; c--) {
      if (xs[r] === ys[c]) {
        table[at(r, c)] = table[at(r + 1, c + 1)] + 1;
      } else {
        table[at(r, c)] = Math.max(table[at(r + 1, c)], table[at(r, c + 1)]);
      }
    }
  }
  const steps: Step[] = [];
  let r = 0;
  let c = 0;
  while (r < m && c < n) {
    if (xs[r] === ys[c]) {
      steps.push("same");
      r++;
      c++;
    } else if (table[at(r + 1, c)] >= table[at(r, c + 1)]) {
      steps.push("del");
      r++;
    } else {
      steps.push("add");
      c++;
    }
  }
  while (r < m) {
    steps.push("del");
    r++;
  }
  while (c < n) {
    steps.push("add");
    c++;
  }
  return steps;
}
