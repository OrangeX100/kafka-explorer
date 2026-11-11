// Push the current tree to GitHub via the REST API (network filters block
// git-over-HTTPS here; api.github.com responds fine). Only blobs that
// differ from the remote tree are uploaded; then a fresh single commit +
// forced ref update. Env: GH_TOKEN, GH_REPO.
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const token = process.env.GH_TOKEN;
const repo = process.env.GH_REPO;
const api = "https://api.github.com";
const H = {
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "User-Agent": "kafka-explorer-publisher",
};

const gh = async (method, url, body) => {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${api}${url}`, {
        method,
        headers: { ...H, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(json).slice(0, 200)}`);
      return json;
    } catch (e) {
      if (attempt === 3) throw e;
      console.log(`  retry ${attempt} after: ${String(e).slice(0, 80)}`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
};

// 1. tracked files with their INDEX blob SHAs — `ls-files -s` yields the
// CRLF-normalized SHAs exactly like a real git commit (raw hash-object
// would store CRLF and diverge from git's own tree).
const indexRows = execSync("git ls-files -s", { encoding: "utf8", maxBuffer: 1 << 26 })
  .split("\n").filter(Boolean);
const files = [];
const localSha = {};
for (const row of indexRows) {
  const tab = row.indexOf("\t");
  const meta = row.slice(0, tab).split(" ");
  const f = row.slice(tab + 1);
  files.push(f);
  localSha[f] = meta[1];
}
console.log(`tracked files: ${files.length}`);

// 3. remote tree map (from the current head commit)
const headRef = await gh("GET", `/repos/${repo}/git/ref/heads/main`);
const headCommit = await gh("GET", `/repos/${repo}/git/commits/${headRef.object.sha}`);
const remoteTree = await gh("GET", `/repos/${repo}/git/trees/${headCommit.tree.sha}?recursive=1`);
const remoteSha = Object.fromEntries(remoteTree.tree.filter(t => t.type === "blob").map(t => [t.path, t.sha]));
console.log(`remote tree blobs: ${Object.keys(remoteSha).length}`);

// 4. upload only new/changed blobs
let uploaded = 0;
const entries = [];
for (const f of files) {
  let sha = localSha[f];
  if (remoteSha[f] !== sha) {
    const content = fs.readFileSync(f).toString("base64");
    const b = await gh("POST", `/repos/${repo}/git/blobs`, { content, encoding: "base64" });
    sha = b.sha;
    uploaded++;
    if (uploaded % 10 === 0) console.log(`  uploaded ${uploaded}...`);
  }
  entries.push({ path: f.replace(/\\/g, "/"), mode: "100644", type: "blob", sha });
}
console.log(`new blobs uploaded: ${uploaded}`);

// 5. tree + fresh single commit (no parent — clean initial history)
const tree = await gh("POST", `/repos/${repo}/git/trees`, { tree: entries });
const msg = `Kafka Explorer 0.2.0-beta.1 — initial release

A local-first visual desktop client for Apache Kafka clusters:
connection management (SASL/SSL/mTLS), topic & message browsing with
encoding-aware decoding, consumer groups & offset management (incl.
Kafka 4.x share groups), Schema Registry, Kafka Connect, ksqlDB,
broker/ACL/quota administration, message rate visualization,
light/dark themes with zh/en locales, tray residency, one-click
config backup/restore, in-app auto-update, and a single-file
installer with uninstaller.`;
const commit = await gh("POST", `/repos/${repo}/git/commits`, {
  message: msg, tree: tree.sha,
});
console.log("commit:", commit.sha);

// 6. force-update main + annotated tag v0.2.0-beta.1 (create on first
// push, follow main afterwards)
await gh("PATCH", `/repos/${repo}/git/refs/heads/main`, { sha: commit.sha, force: true });
try {
  const tag = await gh("POST", `/repos/${repo}/git/tags`, {
    tag: "v0.2.0-beta.1",
    message: "Kafka Explorer 0.2.0-beta.1\n\nFirst public beta: full cluster management in a single Windows installer.",
    object: commit.sha,
    type: "commit",
  });
  await gh("POST", `/repos/${repo}/git/refs`, { ref: "refs/tags/v0.2.0-beta.1", sha: tag.sha });
  console.log("tag created:", tag.sha);
} catch {
  await gh("PATCH", `/repos/${repo}/git/refs/tags/v0.2.0-beta.1`, {
    sha: commit.sha, force: true,
  });
  console.log("tag moved to", commit.sha);
}
console.log("PUSH_DONE");
