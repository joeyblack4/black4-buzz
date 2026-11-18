// The release machinery (scripts/release/*.mjs) against a throwaway Git
// "GitHub": a bare repository as origin and a clone to release from. No
// network; CI and canary results come from a status file.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { addedAccess, buzzRevision, git, mergedPullRequests, Refusal, resolveCommit, showFile } from "../scripts/release/lib.mjs";
import { promote } from "../scripts/release/promote.mjs";
import { rollback } from "../scripts/release/rollback.mjs";
import { movePreview } from "../scripts/release/preview.mjs";
import { channelLink } from "../scripts/release/channel-link.mjs";
import { addedKey, compare, surface } from "../scripts/tool-surface.mjs";

const manifest = (origins) => JSON.stringify({ id: "example.plugin", name: "Example", apiVersion: 1, updates: { defaultEnabled: true }, host: { networkOrigins: origins } }, null, 2);
// A build check like kit/build.mjs --check: built.txt must equal source.txt.
const BUILD = `import { readFileSync } from "node:fs"; if (readFileSync("source.txt","utf8") !== readFileSync("built.txt","utf8")) { console.error("stale"); process.exit(1); }`;

function world(t) {
  const root = mkdtempSync(join(tmpdir(), "black4-release-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = join(root, "origin.git");
  const work = join(root, "work");
  execFileSync("git", ["init", "--bare", "--quiet", "-b", "main", remote]);
  execFileSync("git", ["clone", "--quiet", remote, work], { stdio: "pipe" });
  for (const [k, v] of [["user.name", "Release Test"], ["user.email", "release@example.test"], ["commit.gpgsign", "false"], ["tag.gpgsign", "false"]]) git(work, ["config", k, v]);
  git(work, ["checkout", "--quiet", "-b", "main"]);
  const write = (files) => { for (const [path, text] of Object.entries(files)) { mkdirSync(dirname(join(work, path)), { recursive: true }); writeFileSync(join(work, path), text); } };
  const commit = (files, message = "change") => { write(files); git(work, ["add", "-A"]); git(work, ["commit", "--quiet", "-m", message]); return git(work, ["rev-parse", "HEAD"]); };
  let pr = 0;
  /** A pull request merged with a merge commit, as GitHub does. */
  const merge = (title, files) => {
    const n = ++pr;
    git(work, ["checkout", "--quiet", "-b", `topic-${n}`]);
    commit(files, title);
    git(work, ["checkout", "--quiet", "main"]);
    git(work, ["merge", "--quiet", "--no-ff", `topic-${n}`, "-m", `Merge pull request #${n} from example/topic-${n}`, "-m", title]);
    git(work, ["push", "--quiet", "origin", "main"]);
    return git(work, ["rev-parse", "HEAD"]);
  };
  const statuses = {};
  const statusFile = join(root, "statuses.json");
  const green = (...shas) => { for (const sha of shas) statuses[sha] = { required: "success", "canary / Buzz release v1.0.5": "success" }; writeFileSync(statusFile, JSON.stringify(statuses)); };
  const set = (sha, value) => { statuses[sha] = value; writeFileSync(statusFile, JSON.stringify(statuses)); };
  const push = (ref, sha) => git(work, ["push", "--quiet", "--force", "origin", `${sha}:refs/heads/${ref}`]);
  const remoteTip = (ref) => git(remote, ["rev-parse", "--verify", "--quiet", ref], { allowFail: true }) || null;
  const run = (fn, args) => { const lines = []; const result = fn([...args, "--status", statusFile, "--date", "20261117"], { cwd: work, log: (l) => lines.push(l) }); return { ...result, output: lines.join("\n") }; };
  const refused = (fn, args, pattern) => assert.throws(() => run(fn, args), (e) => e instanceof Refusal && pattern.test(e.message), `expected a refusal matching ${pattern}`);

  const first = commit({
    "package.json": JSON.stringify({ scripts: { check: "node build.mjs --check && echo tests" } }),
    "build.mjs": BUILD, "source.txt": "v1", "built.txt": "v1",
    "plugins/example/manifest.json": manifest(["https://api.example.test"]),
    "plugins/example/plugin.js": "export function apply() {}\n",
  }, "first");
  git(work, ["push", "--quiet", "origin", "main"]);
  return { root, remote, work, commit, merge, green, set, push, remoteTip, run, refused, first };
}

test("a first release tags the commit, moves stable and writes notes from the merged pull requests", (t) => {
  const w = world(t);
  const a = w.merge("Show waiting reviews first", { "plugins/example/plugin.js": "export function apply() { /* a */ }\n" });
  w.push("preview", a);
  w.green(a);
  const dry = w.run(promote, [a, "--dry-run"]);
  assert.equal(dry.tag, "release-20261117-1");
  assert.match(dry.output, /Dry run: would tag release-20261117-1/);
  assert.match(dry.notes, /Show waiting reviews first \(.*1\)/);
  assert.equal(w.remoteTip("stable"), null, "a dry run pushes nothing");
  assert.equal(git(w.remote, ["tag", "--list"]), "");

  const real = w.run(promote, [a]);
  assert.equal(w.remoteTip("stable"), a);
  assert.equal(git(w.remote, ["rev-parse", "release-20261117-1^{commit}"]), a);
  assert.match(git(w.remote, ["tag", "-l", "--format=%(contents)", "release-20261117-1"]), /Show waiting reviews first/);
  assert.match(real.notes, /example\.plugin \(plugins\/example\): offers Update and reload; Buzz revision [0-9a-f]{64}/);

  const b = w.merge("Fix the badge", { "plugins/example/plugin.js": "export function apply() { /* b */ }\n" });
  w.push("preview", b);
  w.green(b);
  const second = w.run(promote, [b]);
  assert.equal(second.tag, "release-20261117-2", "the second release of a day is -2");
  assert.match(second.notes, /Fix the badge/);
  assert.doesNotMatch(second.notes, /Show waiting reviews first/, "notes cover only what is new since the last stable");
  assert.match(second.notes, /Previous stable: .* \(release-20261117-1\)/);
});

test("promote refuses a commit that is not on main, not soaked on preview, older than stable or already stable", (t) => {
  const w = world(t);
  git(w.work, ["checkout", "--quiet", "-b", "side"]);
  const side = w.commit({ "x.txt": "side" }, "side work");
  git(w.work, ["push", "--quiet", "origin", "side"]);
  git(w.work, ["checkout", "--quiet", "main"]);
  w.green(side);
  w.refused(promote, [side], /is not on main/);

  const a = w.merge("A", { "a.txt": "a" });
  const inside = git(w.work, ["rev-parse", `${a}^2`]); // the pull request's own commit, green on its PR run
  w.green(a, inside);
  w.push("preview", a);
  w.refused(promote, [inside], /inside a merged branch/);
  w.push("preview", w.first);
  w.refused(promote, [a], /has not reached preview yet/);
  assert.equal(w.run(promote, [a, "--allow-unsoaked", "--dry-run"]).dryRun, true, "--allow-unsoaked skips the soak");
  w.push("preview", a);
  w.run(promote, [a]);
  w.refused(promote, [a], /already stable/);
  w.green(w.first);
  w.refused(promote, [w.first, "--allow-unsoaked"], /not newer than stable.*rollback/);
});

test("promote refuses red or missing CI, a canary that has not passed, and stale built folders", (t) => {
  const w = world(t);
  const a = w.merge("A", { "a.txt": "a" });
  w.push("preview", a);
  w.refused(promote, [a], /CI on .* is missing/);
  w.set(a, { required: "failure", "canary / Buzz release v1.0.5": "success" });
  w.refused(promote, [a], /CI on .* is failure/);
  w.set(a, { required: "success", "canary / Buzz release v1.0.5": "failure" });
  w.refused(promote, [a], /Buzz canary has not passed/);
  assert.equal(w.run(promote, [a, "--canary-verified", "--dry-run"]).dryRun, true, "the release workflow's own canary run counts");

  const stale = w.merge("Forgot to rebuild", { "source.txt": "v2" });
  w.push("preview", stale);
  w.green(stale);
  w.refused(promote, [stale], /built plugin folders at .* are stale \(node build\.mjs --check\)/);
  const fixed = w.merge("Rebuild", { "built.txt": "v2" });
  w.push("preview", fixed);
  w.green(fixed);
  assert.equal(w.run(promote, [fixed, "--dry-run"]).dryRun, true);
});

test("promote refuses more host access unless --ack-permissions; less access needs no flag", (t) => {
  const w = world(t);
  const a = w.merge("A", { "a.txt": "a" });
  w.push("preview", a); w.green(a); w.run(promote, [a]);
  const more = w.merge("Reach the door", { "plugins/example/manifest.json": manifest(["https://api.example.test", "https://door.example.test"]) });
  w.push("preview", more); w.green(more);
  w.refused(promote, [more], /example\.plugin adds HTTPS origin: https:\/\/door\.example\.test, so every person must review permissions/);
  const acked = w.run(promote, [more, "--ack-permissions"]);
  assert.match(acked.notes, /## Permission review\n\n- example\.plugin asks people to review new access: HTTPS origin: https:\/\/door\.example\.test/);
  const less = w.merge("Drop the door", { "plugins/example/manifest.json": manifest(["https://api.example.test"]) });
  w.push("preview", less); w.green(less);
  assert.equal(w.run(promote, [less]).dryRun, false);
});

test("rollback moves stable back to the previous release, and promote then refuses the commit it undid", (t) => {
  const w = world(t);
  const a = w.merge("Good", { "plugins/example/plugin.js": "export function apply() { /* good */ }\n" });
  w.push("preview", a); w.green(a); w.run(promote, [a]);
  const bad = w.merge("Bad", { "plugins/example/plugin.js": "export function apply() { throw new Error(); }\n" });
  w.push("preview", bad); w.green(bad); w.run(promote, [bad]);
  assert.equal(w.remoteTip("stable"), bad);

  const dry = w.run(rollback, ["--dry-run"]);
  assert.match(dry.output, /would move stable from .* \(release-20261117-2\) back to release-20261117-1/);
  assert.equal(w.remoteTip("stable"), bad, "a dry run pushes nothing");
  const done = w.run(rollback, []);
  assert.equal(done.tag, "rollback-20261117-1");
  assert.equal(w.remoteTip("stable"), a);
  assert.match(git(w.remote, ["tag", "-l", "--format=%(contents)", "rollback-20261117-1"]), new RegExp(`Rolled back: ${bad}`));
  assert.equal(w.remoteTip("main"), bad, "main keeps the bad commit until a fix lands");

  w.refused(promote, [bad], /was rolled back/);
  const fix = w.merge("Fix", { "plugins/example/plugin.js": "export function apply() { /* fixed */ }\n" });
  w.push("preview", fix); w.green(fix);
  assert.equal(w.run(promote, [fix]).tag, "release-20261117-3", "a fix after a rollback releases normally");
  w.refused(rollback, ["--to", "v1"], /not a release tag/);
});

test("the first release over an untagged stable tags it as a baseline, so it can be rolled back", (t) => {
  const w = world(t);
  w.push("stable", w.first); // stable as it is before this machinery
  const a = w.merge("First through promote", { "plugins/example/plugin.js": "export function apply() { /* a */ }\n" });
  w.push("preview", a); w.green(a);
  assert.match(w.run(promote, [a, "--dry-run"]).output, /tag today's stable release-20261117-1 as a baseline, tag release-20261117-2/);
  const done = w.run(promote, [a]);
  assert.equal(done.baseline, "release-20261117-1");
  assert.equal(git(w.remote, ["rev-parse", "release-20261117-1^{commit}"]), w.first);
  assert.equal(git(w.remote, ["rev-parse", "release-20261117-2^{commit}"]), a);
  w.run(rollback, []);
  assert.equal(w.remoteTip("stable"), w.first);
});

test("rollback refuses when there is nothing earlier to go back to", (t) => {
  const w = world(t);
  const a = w.merge("Only", { "a.txt": "a" });
  w.push("preview", a); w.green(a); w.run(promote, [a]);
  w.refused(rollback, [], /no earlier release/);
});

test("preview only moves forward along main", (t) => {
  const w = world(t);
  const a = w.merge("A", { "a.txt": "a" });
  const b = w.merge("B", { "b.txt": "b" });
  assert.equal(w.run(movePreview, [b]).moved, true);
  assert.equal(w.remoteTip("preview"), b);
  const late = w.run(movePreview, [a]);
  assert.equal(late.moved, false, "a late run for an older commit changes nothing");
  assert.equal(w.remoteTip("preview"), b);
  git(w.work, ["checkout", "--quiet", "-b", "side"]);
  const side = w.commit({ "s.txt": "s" }, "side");
  git(w.work, ["checkout", "--quiet", "main"]);
  w.refused(movePreview, [side], /not one of main's own commits/);
  assert.equal(w.run(movePreview, [b, "--dry-run"]).moved, false);
});

test("release notes name pull requests from merge and squash commits", (t) => {
  const w = world(t);
  const a = w.merge("Merged the usual way", { "a.txt": "a" });
  w.commit({ "b.txt": "b" }, "Squashed change (#41)");
  const prs = mergedPullRequests(w.work, w.first, git(w.work, ["rev-parse", "HEAD"]));
  assert.deepEqual(prs.map((p) => [p.number, p.title]), [[41, "Squashed change"], [1, "Merged the usual way"]]);
  assert.ok(a);
});

test("access growth follows Buzz's update review: new origins, processes and flags grow, removals do not", () => {
  const m = (host) => ({ id: "x", name: "X", apiVersion: 1, host });
  assert.deepEqual(addedAccess(m({ networkOrigins: ["https://a.test"] }), m({ networkOrigins: ["https://a.test"] })), []);
  assert.deepEqual(addedAccess(m({ networkOrigins: ["https://a.test"] }), m({ networkOrigins: [] })), []);
  assert.deepEqual(addedAccess(m({}), m({ files: true })), ["Files"]);
  assert.equal(addedAccess(m({ processes: [{ id: "p", program: "claude" }] }), m({ processes: [{ id: "p", program: "claude", args: ["--x"] }] })).length, 1, "changed arguments are new access");
});

test("buzzRevision equals the revision a real Buzz stored for this repository's plugin", (t) => {
  // Buzz 1.0.5 on a Black 4 Mac stored ai.black4 from f295953 as revision 566d8fef….
  const cwd = new URL("..", import.meta.url).pathname;
  const commit = resolveCommit(cwd, "f2959536901e996f66ca28f369d78c37f17a72e2");
  if (!commit) return t.skip("needs full history (actions/checkout fetch-depth: 0)");
  const revision = buzzRevision({ manifest: showFile(cwd, commit, "plugins/black4/manifest.json"), code: showFile(cwd, commit, "plugins/black4/plugin.js") });
  assert.equal(revision, "566d8fefa71bb222ce1812a2008a57f08a35f9c3dec0aa625c2166fe028dae14");
  assert.equal(buzzRevision({ manifest: '{"id":"x","name":"X","apiVersion":1,"surprise":true}', code: "x" }), null, "an unknown manifest key gives no guess");
});

test("the channel link pins a commit and folder so Buzz updates the installed plugin in place", () => {
  const link = channelLink("preview", "black4", "a".repeat(40));
  assert.equal(link, `buzz://plugin-install?repository=joeyblack4%2Fblack4-buzz&ref=preview&path=plugins%2Fblack4&commit=${"a".repeat(40)}`);
});

test("the tool surface sees a change to what agents are shown, and only that", (t) => {
  const root = mkdtempSync(join(tmpdir(), "black4-tools-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const plugin = new URL("../plugins/black4/plugin.js", import.meta.url).pathname;
  const base = surface(plugin);
  assert.equal(base.error, undefined, base.error);
  assert.ok(base.tools.length > 0 && base.tools.every((tool) => tool.name.startsWith("black4_")));
  assert.ok(!base.tools.some((tool) => tool.name === "black4_renew_signin"), "renew_signin is never offered to agents");
  assert.equal(addedKey(base.tools), base.key);
  const source = execFileSync("cat", [plugin], { encoding: "utf8" });
  const edited = join(root, "edited.js");
  writeFileSync(edited, source.replace("`Black 4: ${tool.description", "`Black 4 · ${tool.description"));
  const head = surface(edited);
  assert.notEqual(head.key, base.key);
  assert.ok(compare(base, head).some((line) => /description changed/.test(line)));
  const cosmetic = join(root, "cosmetic.js");
  writeFileSync(cosmetic, `${source}\n// a comment changes no tool\n`);
  assert.equal(surface(cosmetic).key, base.key);
});
