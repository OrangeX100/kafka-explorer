// Push local git history to GitHub via the REST API (network filters block
// git-over-HTTPS here; api.github.com responds fine). Chain pusher: replays
// the local commit chain onto the remote branch — per commit it uploads
// missing blobs (binary-safe), rebuilds trees and commits with identical
// content, then moves the ref. Author/committer/dates are replayed from the
// raw commit objects so GitHub reproduces the same object bytes and the
// remote shas match local git exactly (verified in practice).
//
// Only commits the remote branch is missing are replayed; remote history is
// never rewritten unless GH_REBUILD=1 (or the branch does not exist yet).
//
// Env: GH_TOKEN (required), GH_REPO (required, "owner/name"),
// GH_REF (branch, default: current git branch),
// GH_REBUILD=1 (replay the whole chain from the root commit),
// GH_TAG (create/move this release tag on the pushed head; omit = tag untouched).
import { execSync } from "node:child_process";

const token = process.env.GH_TOKEN;
const repo = process.env.GH_REPO;
const ref = (process.env.GH_REF || execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8" }).trim()).trim();
const rebuild = process.env.GH_REBUILD === "1";
const releaseTag = process.env.GH_TAG;
const api = "https://api.github.com";
const TAB = "\t";
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
      if (!res.ok) {
        const err = new Error(`${res.status} ${JSON.stringify(json).slice(0, 200)}`);
        err.status = res.status;
        throw err;
      }
      return json;
    } catch (e) {
      if (attempt === 3) throw e;
      console.log(`  retry ${attempt} after: ${String(e).slice(0, 80)}`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
};

// --- local commit chain (oldest first) ---
const localAll = execSync("git rev-list --reverse HEAD", { encoding: "utf8", maxBuffer: 1 << 26 })
  .split("\n").filter(Boolean);
console.log(`local history: ${localAll.length} commits, branch ${ref}`);

// --- remote branch state ---
let remoteHead = null;
try {
  remoteHead = (await gh("GET", `/repos/${repo}/git/ref/heads/${ref}`)).object.sha;
} catch (e) {
  if (e.status !== 404) throw e;
}
let commits;
if (remoteHead && localAll.includes(remoteHead) && !rebuild) {
  const idx = localAll.indexOf(remoteHead);
  commits = localAll.slice(idx + 1);
  console.log(`remote head ${remoteHead.slice(0, 8)} is local ancestor → ${commits.length} commit(s) to replay`);
} else if (remoteHead && !rebuild) {
  console.error(`ABORT: remote ${ref} (${remoteHead.slice(0, 8)}) is not in local history. Pass GH_REBUILD=1 to rewrite it deliberately.`);
  process.exit(1);
} else {
  commits = localAll;
  console.log(`full chain replay: ${commits.length} commit(s)${remoteHead ? " (GH_REBUILD)" : " (branch empty)"}`);
}
const pushTag = async (targetSha) => {
  if (!releaseTag) return;
  try {
    const tagObj = await gh("POST", `/repos/${repo}/git/tags`, {
      tag: releaseTag,
      message: `Release ${releaseTag}`,
      object: targetSha,
      type: "commit",
    });
    await gh("POST", `/repos/${repo}/git/refs`, { ref: "refs/tags/" + releaseTag, sha: tagObj.sha });
    console.log(`tag ${releaseTag} created at ${targetSha.slice(0, 8)}`);
  } catch {
    await gh("PATCH", `/repos/${repo}/git/refs/tags/${releaseTag}`, { sha: targetSha, force: true });
    console.log(`tag ${releaseTag} moved to ${targetSha.slice(0, 8)}`);
  }
};

if (commits.length === 0) {
  console.log("nothing to push; tagging remote head only");
  await pushTag(remoteHead);
  console.log("PUSH_DONE");
  process.exit(0);
}

// local commit raw objects: git cat-file gives the EXACT stored bytes
// (avoids format strings — cmd.exe mangles % and tabs in arguments).
const parseCommit = (sha) => {
  const raw = execSync(`git cat-file commit ${sha}`, { encoding: "utf8", maxBuffer: 1 << 24 });
  const cut = raw.indexOf("\n\n");
  const head = raw.slice(0, cut);
  const message = raw.slice(cut + 2); // exact message bytes incl. trailing newline
  let tree = null;
  const parents = [];
  let author = null, committer = null;
  for (const line of head.split("\n")) {
    if (line.startsWith("tree ")) tree = line.slice(5);
    else if (line.startsWith("parent ")) parents.push(line.slice(7));
    else if (line.startsWith("author ")) author = line.slice(7);
    else if (line.startsWith("committer ")) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
};

// "Name <email> 1731423590 +0800" → { name, email, date }
const ident = (line) => {
  const m = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (!m) throw new Error(`bad ident line: ${line}`);
  const [, name, email, unix, tz] = m;
  const sign = tz[0] === "-" ? -1 : 1;
  const shifted = new Date((+unix + sign * (+tz.slice(1, 3) * 60 + +tz.slice(3, 5)) * 60) * 1000).toISOString();
  return { name, email, date: shifted.slice(0, 19) + tz[0] + tz.slice(1, 3) + ":" + tz.slice(3, 5) };
};

// blobs already on the remote are content-addressed and immutable — collect
// them once so replays skip re-uploading everything
const remoteBlobs = new Set();
if (remoteHead) {
  const headCommit = await gh("GET", `/repos/${repo}/git/commits/${remoteHead}`);
  const t = await gh("GET", `/repos/${repo}/git/trees/${headCommit.tree.sha}?recursive=1`);
  for (const item of t.tree) if (item.type === "blob") remoteBlobs.add(item.sha);
  console.log(`remote tree blobs already known: ${remoteBlobs.size}`);
}

// localC → remote { commit, tree }; seeds with the remote head so the first
// replayed commit chains onto it
const remoteOf = new Map();
const remoteTreeOf = new Map();
if (remoteHead) {
  remoteOf.set(remoteHead, remoteHead);
  remoteTreeOf.set(remoteHead, (await gh("GET", `/repos/${repo}/git/commits/${remoteHead}`)).tree.sha);
}

const uploadBlob = async (sha) => {
  if (remoteBlobs.has(sha)) return;
  // buffer encoding is mandatory: utf8 would corrupt binary blobs
  const content = execSync(`git cat-file blob ${sha}`, { encoding: "buffer", maxBuffer: 1 << 28 }).toString("base64");
  for (let attempt = 1; attempt <= 2; attempt++) {
    const b = await gh("POST", `/repos/${repo}/git/blobs`, { content, encoding: "base64" });
    if (b.sha === sha) { // network byte-flip guard
      remoteBlobs.add(sha);
      return;
    }
    if (attempt === 2) throw new Error(`blob sha mismatch after upload: want ${sha} got ${b.sha}`);
    console.log(`  blob sha mismatch (${b.sha.slice(0, 8)}), retrying`);
  }
};

let uploaded = 0;
for (const c of commits) {
  const meta = parseCommit(c);
  const subject = meta.message.split("\n")[0].slice(0, 60);
  const parentLocal = meta.parents[0] || null;
  if (meta.parents.length > 1) throw new Error(`merge commit ${c} not supported`);
  const parentRemote = parentLocal ? remoteOf.get(parentLocal) : null;
  const parentRemoteTree = parentLocal ? remoteTreeOf.get(parentLocal) : null;
  if (parentLocal && !parentRemote) throw new Error(`parent ${parentLocal} of ${c} is not on the replay path`);

  // tree entries: root commit lists everything; later commits diff against
  // their parent (raw output, ":"-prefixed lines; cmd.exe caret-safe)
  const entries = [];
  if (!parentLocal) {
    const rows = execSync(`git ls-tree -r ${c}`, { encoding: "utf8", maxBuffer: 1 << 26 }).split("\n").filter(Boolean);
    for (const row of rows) {
      const tab = row.indexOf(TAB);
      const [mode, type, sha] = row.slice(0, tab).split(" ");
      entries.push({ path: row.slice(tab + 1), mode, type, sha });
    }
  } else {
    const rows = execSync(`git diff-tree -r --no-renames ${parentLocal} ${c}`, { encoding: "utf8", maxBuffer: 1 << 26 })
      .split("\n").filter((l) => l.startsWith(":"));
    for (const row of rows) {
      const tab = row.indexOf(TAB);
      const meta2 = row.slice(0, tab).split(" "); // :oldmode newmode oldsha newsha status
      const path = row.slice(tab + 1);
      const status = meta2[4];
      if (status === "D") {
        entries.push({ path, sha: null });
      } else {
        entries.push({ path, mode: meta2[1], type: meta2[1] === "160000" ? "commit" : "blob", sha: meta2[3] });
      }
    }
  }
  for (const e of entries) if (e.sha) await uploadBlob(e.sha);
  uploaded += entries.filter((e) => e.sha).length;

  const treeBody = { tree: entries.map((e) => e.sha ? { path: e.path, mode: e.mode, type: e.type, sha: e.sha } : { path: e.path, sha: null }) };
  if (parentRemoteTree) treeBody.base_tree = parentRemoteTree;
  const tree = await gh("POST", `/repos/${repo}/git/trees`, treeBody);
  const treeMark = tree.sha === meta.tree ? "tree=ok" : `tree=DIFF(want ${meta.tree.slice(0, 8)})`;

  const commit = await gh("POST", `/repos/${repo}/git/commits`, {
    message: meta.message,
    tree: tree.sha,
    parents: parentRemote ? [parentRemote] : [],
    author: ident(meta.author),
    committer: ident(meta.committer),
  });
  const shaMark = commit.sha === c ? "sha=ok" : `sha=DIFF(want ${c.slice(0, 8)})`;
  console.log(`replayed ${c.slice(0, 8)} "${subject}" ${treeMark} ${shaMark} (+${entries.filter((e) => e.sha).length} blobs)`);
  remoteOf.set(c, commit.sha);
  remoteTreeOf.set(c, tree.sha);
}
console.log(`blobs processed: ${uploaded} new / ${remoteBlobs.size} known`);

const lastRemote = remoteOf.get(commits[commits.length - 1]);
if (remoteHead) {
  await gh("PATCH", `/repos/${repo}/git/refs/heads/${ref}`, { sha: lastRemote, force: rebuild });
} else {
  await gh("POST", `/repos/${repo}/git/refs`, { ref: "refs/heads/" + ref, sha: lastRemote });
}
console.log(`ref heads/${ref} → ${lastRemote.slice(0, 8)}`);
await pushTag(lastRemote);
console.log("PUSH_DONE");
