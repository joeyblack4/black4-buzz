// What the release scripts share: Git in a given folder, Buzz's own idea of
// "more access" and of a plugin revision, and release notes. Pure Node, no
// dependencies, so it runs in CI and in a temporary repository in tests.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

/** A refusal: one plain sentence, printed as is, exit code 1. */
export class Refusal extends Error {}
export const refuse = (sentence) => { throw new Refusal(sentence); };

/** Git in `cwd`. Returns trimmed stdout; throws with Git's stderr. */
export function git(cwd, args, { input, allowFail = false, raw = false } = {}) {
  try {
    const out = execFileSync("git", args, { cwd, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
    return raw ? out : out.trim();
  } catch (error) {
    if (allowFail) return null;
    const text = String(error.stderr || error.message).trim();
    throw new Error(`git ${args.join(" ")}: ${text}`);
  }
}
export const isAncestor = (cwd, older, newer) =>
  git(cwd, ["merge-base", "--is-ancestor", older, newer], { allowFail: true }) !== null;
/** True when `sha` is a commit of main itself (its first-parent line): a merge
 * or a direct commit, never a commit from inside a merged branch, whose own
 * tree CI on main never tested. */
export function onFirstParent(cwd, sha, tip) {
  if (!tip || !isAncestor(cwd, sha, tip)) return false;
  return git(cwd, ["rev-list", "--first-parent", tip]).split("\n").includes(sha);
}
export const resolveCommit = (cwd, ref) => git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { allowFail: true }) || null;
/** A file's exact bytes at a commit (as text), or null when it is not there. */
export const showFile = (cwd, commit, path) => git(cwd, ["show", `${commit}:${path}`], { allowFail: true, raw: true });

/** The plugin folders at a commit: { "plugins/black4": { manifest, code } }. */
export function pluginsAt(cwd, commit) {
  const out = {};
  const listed = git(cwd, ["ls-tree", "--name-only", `${commit}:plugins`], { allowFail: true });
  for (const name of (listed ?? "").split("\n").filter(Boolean)) {
    const dir = `plugins/${name}`;
    const manifest = showFile(cwd, commit, `${dir}/manifest.json`);
    if (manifest === null) continue;
    out[dir] = { manifest, code: showFile(cwd, commit, `${dir}/plugin.js`) ?? "", readme: showFile(cwd, commit, `${dir}/README.md`), hasIcon: [`${dir}/icon.png`, `${dir}/icon.jpg`].some((p) => showFile(cwd, commit, p) !== null) };
  }
  return out;
}

// ---- Access, as Buzz judges it ----------------------------------------------
// A port of hostDeclarations()/pluginAccessIncreases() in Buzz v1.0.5
// src/app/PluginAccessReview.tsx: an update asks the person to review
// permissions when the new manifest declares any grant whose signature the
// installed one does not. Keep in step with Buzz when the canary flags a
// manifest change.
export function accessSignatures(manifest) {
  const host = manifest?.host ?? {};
  const out = [];
  for (const harness of host.agentExecution ?? []) out.push(`Agent execution: ${harness}`);
  for (const harness of host.agentHooks ?? []) out.push(`Agent hooks: ${harness}`);
  for (const c of host.commands ?? []) {
    out.push(`Command ${c.id}: ${JSON.stringify([c.program, ...(c.args ?? [])])} · input: ${c.maxInputBytes === undefined ? "none" : `up to ${c.maxInputBytes} bytes`} · output: up to ${c.maxOutputBytes ?? 4096} bytes`);
  }
  for (const origin of host.networkOrigins ?? []) out.push(`HTTPS origin: ${origin}`);
  if (host.publicImages) out.push("Public images");
  if (host.publicPages) out.push("Public pages");
  for (const op of host.federatedIdentity?.operations ?? []) out.push(`Federated authority ${host.federatedIdentity.authority}: ${op.method} ${op.path}`);
  for (const p of host.processes ?? []) {
    out.push(`Process ${p.id}: ${JSON.stringify([p.program, ...(p.args ?? [])])}${p.bundled ? " (bundled with Buzz)" : ""} · artifact: ${JSON.stringify(p.artifact ?? null)}`);
  }
  if (host.mcp) out.push("MCP servers");
  if (host.managedFiles) out.push("Managed files");
  if (host.files) out.push("Files");
  return out;
}
/** Grants `next` declares that `previous` did not: what Buzz asks people to review. */
export function addedAccess(previous, next) {
  const had = new Set(accessSignatures(previous));
  return accessSignatures(next).filter((s) => !had.has(s));
}

/** For every plugin in both commits: the grants that would need a review. */
export function accessGrowth(cwd, fromCommit, toCommit) {
  const before = pluginsAt(cwd, fromCommit);
  const after = pluginsAt(cwd, toCommit);
  const grown = [];
  for (const [dir, next] of Object.entries(after)) {
    if (!before[dir]) continue; // a new plugin is a new install, reviewed in full anyway
    const added = addedAccess(JSON.parse(before[dir].manifest), JSON.parse(next.manifest));
    if (added.length) grown.push({ dir, id: JSON.parse(next.manifest).id, added });
  }
  return grown;
}

// ---- Revision, as Buzz computes it ------------------------------------------
// Buzz names an installed release by sha256 of the artifact it stores:
// serde_json of { manifest, code } with the manifest re-serialized through its
// Rust struct (crates/plugin-manager/src/lib.rs, Buzz v1.0.5): field order is
// the struct's, `host.commands` and `host.networkOrigins` always appear, other
// empty lists and false flags are left out, unknown discovery keys dropped.
// It is what ctx.pluginOwner.revision holds and what an update compares, so a
// commit that does not change a plugin's folder offers no update. Checked
// against ten artifacts a real Buzz stored (tests/release.test.mjs). Returns
// null (unknown) for anything this port does not cover rather than guess.
const pick = (obj, allowed, where) => {
  for (const key of Object.keys(obj)) if (!allowed.includes(key)) throw new Error(`${where}.${key}`);
  return obj;
};
function canonicalManifest(m) {
  pick(m, ["id", "name", "apiVersion", "description", "updates", "discovery", "host"], "manifest");
  const out = { id: m.id, name: m.name, apiVersion: m.apiVersion };
  if (m.description != null) out.description = m.description;
  if (m.updates != null) out.updates = { defaultEnabled: pick(m.updates, ["defaultEnabled"], "updates").defaultEnabled };
  if (m.discovery != null) {
    const d = {};
    if (m.discovery.category != null) d.category = m.discovery.category;
    if (m.discovery.tags?.length) d.tags = m.discovery.tags;
    out.discovery = d;
  }
  if (m.host != null) {
    const h = pick(m.host, ["federatedIdentity", "agentHooks", "agentExecution", "commands", "networkOrigins", "processes", "mcp", "files", "managedFiles", "publicImages", "publicPages"], "host");
    const host = {};
    if (h.federatedIdentity != null) {
      pick(h.federatedIdentity, ["authority", "operations"], "host.federatedIdentity");
      host.federatedIdentity = { authority: h.federatedIdentity.authority, operations: h.federatedIdentity.operations.map((o) => ({ method: o.method, path: o.path })) };
    }
    if (h.agentHooks?.length) host.agentHooks = h.agentHooks;
    if (h.agentExecution?.length) host.agentExecution = h.agentExecution;
    const artifact = (a, where) => {
      pick(a, ["path", "sha256", "siblings"], where);
      const o = { path: a.path, sha256: a.sha256 };
      if (a.siblings?.length) o.siblings = a.siblings.map((s) => ({ name: s.name, sha256: s.sha256 }));
      return o;
    };
    host.commands = (h.commands ?? []).map((c) => {
      pick(c, ["id", "program", "args", "maxInputBytes", "maxOutputBytes", "artifact"], "host.commands[]");
      const o = { id: c.id, program: c.program, args: c.args };
      if (c.maxInputBytes != null) o.maxInputBytes = c.maxInputBytes;
      if (c.maxOutputBytes != null) o.maxOutputBytes = c.maxOutputBytes;
      if (c.artifact != null) o.artifact = artifact(c.artifact, "host.commands[].artifact");
      return o;
    });
    host.networkOrigins = h.networkOrigins ?? [];
    if (h.processes?.length) {
      host.processes = h.processes.map((p) => {
        pick(p, ["id", "program", "args", "bundled", "artifact"], "host.processes[]");
        const o = { id: p.id, program: p.program, args: p.args ?? [] };
        if (p.bundled) o.bundled = true;
        if (p.artifact != null) o.artifact = artifact(p.artifact, "host.processes[].artifact");
        return o;
      });
    }
    for (const flag of ["mcp", "files", "managedFiles", "publicImages", "publicPages"]) if (h[flag]) host[flag] = true;
    out.host = host;
  }
  return out;
}
/** Buzz's revision for a plugin folder's contents, or null when unknown. */
export function buzzRevision({ manifest, code, readme = null, hasIcon = false }) {
  if (readme !== null || hasIcon) return null; // the artifact's readme/icon fields are not ported
  try {
    const bytes = JSON.stringify({ manifest: canonicalManifest(JSON.parse(manifest)), code });
    return createHash("sha256").update(Buffer.from(bytes, "utf8")).digest("hex");
  } catch {
    return null;
  }
}

// ---- Release tags and notes -------------------------------------------------
export const RELEASE_TAG = /^release-(\d{8})-(\d+)$/;
export const ROLLBACK_TAG = /^rollback-(\d{8})-(\d+)$/;
const byTag = (re) => (a, b) => {
  const [, da, na] = a.match(re);
  const [, db, nb] = b.match(re);
  return da === db ? Number(na) - Number(nb) : da < db ? -1 : 1;
};
/** Release tags, oldest first. */
export function releaseTags(cwd) {
  return git(cwd, ["tag", "--list", "release-*"]).split("\n").filter((t) => RELEASE_TAG.test(t)).sort(byTag(RELEASE_TAG));
}
export function nextTag(cwd, prefix, date) {
  const re = prefix === "release" ? RELEASE_TAG : ROLLBACK_TAG;
  const same = git(cwd, ["tag", "--list", `${prefix}-${date}-*`]).split("\n").filter((t) => re.test(t));
  const n = same.reduce((max, t) => Math.max(max, Number(t.match(re)[2])), 0) + 1;
  return `${prefix}-${date}-${n}`;
}
export const today = () => new Date().toISOString().slice(0, 10).replaceAll("-", "");
export const tagCommit = (cwd, tag) => resolveCommit(cwd, `refs/tags/${tag}`);
/** Commits undone by a rollback: each rollback tag's message names it on a `Rolled back:` line. */
export function rolledBack(cwd) {
  const out = new Set();
  for (const tag of git(cwd, ["tag", "--list", "rollback-*"]).split("\n").filter(Boolean)) {
    const text = git(cwd, ["tag", "-l", "--format=%(contents)", tag]);
    for (const m of text.matchAll(/^Rolled back: ([0-9a-f]{40})/gm)) out.add(m[1]);
  }
  return out;
}

/** The pull requests merged between two commits on main's first-parent line. */
export function mergedPullRequests(cwd, from, to) {
  const range = from ? `${from}..${to}` : to;
  const log = git(cwd, ["log", "--first-parent", "--format=%H%x1f%s%x1f%b%x1e", range]);
  const entries = [];
  for (const record of log.split("\x1e").map((r) => r.trim()).filter(Boolean)) {
    const [sha, subject, body = ""] = record.split("\x1f");
    let m = subject.match(/^Merge pull request #(\d+) from (\S+)/);
    if (m) { entries.push({ sha, number: Number(m[1]), title: body.trim().split("\n")[0] || m[2] }); continue; }
    m = subject.match(/^(.*) \(#(\d+)\)$/); // squash merge
    if (m) { entries.push({ sha, number: Number(m[2]), title: m[1] }); continue; }
    entries.push({ sha, number: null, title: subject });
  }
  return entries;
}

export function releaseNotes({ tag, commit, previous, previousTag, prs, plugins, changed, access, repoUrl }) {
  const lines = [`${tag}`, "", `Commit: ${commit}`, `Previous stable: ${previous ?? "none"}${previousTag ? ` (${previousTag})` : ""}`, ""];
  lines.push("## Changes", "");
  if (!prs.length) lines.push("- No commits since the previous stable.");
  for (const pr of prs) {
    lines.push(pr.number ? `- ${pr.title} (${repoUrl ? `${repoUrl}/pull/${pr.number}` : `#${pr.number}`})` : `- ${pr.title} (direct commit ${pr.sha.slice(0, 10)})`);
  }
  lines.push("", "## What people's Buzz will do", "");
  for (const [dir, info] of Object.entries(plugins)) {
    const id = JSON.parse(info.manifest).id;
    const verb = changed.includes(dir) ? "offers Update and reload" : "unchanged, no update offered";
    lines.push(`- ${id} (${dir}): ${verb}; Buzz revision ${info.revision ?? "unknown"}`);
  }
  if (access.length) {
    lines.push("", "## Permission review", "");
    for (const g of access) lines.push(`- ${g.id} asks people to review new access: ${g.added.join("; ")}`);
  }
  return lines.join("\n") + "\n";
}

// ---- Steps of `npm run check` ------------------------------------------------
/** The `check` script of a package.json, split into its `&&` steps. */
export function checkSteps(packageJson) {
  const script = JSON.parse(packageJson).scripts?.check ?? "";
  return script.split("&&").map((s) => s.trim()).filter(Boolean);
}
/** Steps that compare a built or stamped copy with its source (`… --check`). */
export const isBuildCheck = (step) => /--check\b/.test(step);
/** The agent-machine tests: slow (about 2.5 minutes) and only about machine/. */
export const isMachineStep = (step) => /\bmachine\/tests\b/.test(step);

/** Fetches main, stable, preview and the tags from `remote`. */
export function fetchChannels(cwd, remote) {
  git(cwd, ["fetch", "--quiet", "--prune", "--tags", remote,
    `+refs/heads/main:refs/remotes/${remote}/main`,
    `+refs/heads/stable:refs/remotes/${remote}/stable`,
    `+refs/heads/preview:refs/remotes/${remote}/preview`], { allowFail: true })
    ?? git(cwd, ["fetch", "--quiet", "--prune", "--tags", remote]);
  return {
    main: resolveCommit(cwd, `refs/remotes/${remote}/main`),
    stable: resolveCommit(cwd, `refs/remotes/${remote}/stable`),
    preview: resolveCommit(cwd, `refs/remotes/${remote}/preview`),
  };
}

/** The GitHub slug (owner/name) of a remote, for gh and links. */
export function repoSlug(cwd, remote) {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  const url = git(cwd, ["remote", "get-url", remote], { allowFail: true }) ?? "";
  const m = url.match(/github\.com[:/]([^/]+\/[^/.]+?)(\.git)?$/);
  return m ? m[1] : null;
}

/** Parses `--flag`, `--key value` and positionals. */
export function parseArgs(argv, flags = []) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) { out._.push(arg); continue; }
    const key = arg.slice(2);
    if (key.includes("=")) { const [k, ...v] = key.split("="); out[k] = v.join("="); continue; }
    if (flags.includes(key)) out[key] = true;
    else out[key] = argv[++i];
  }
  return out;
}

/** Runs a CLI main, turning a Refusal into one sentence and exit 1. */
export async function cli(main) {
  try {
    await main();
  } catch (error) {
    if (error instanceof Refusal) {
      console.error(`Refused: ${error.message}`);
      if (process.env.GITHUB_ACTIONS) console.log(`::error::${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}
