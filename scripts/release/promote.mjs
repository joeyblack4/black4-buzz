#!/usr/bin/env node
// Releases one commit: moves `stable` to it, tags it release-YYYYMMDD-N and
// writes release notes from the merged pull requests. Refuses, in one
// sentence, unless the commit is on main, has reached preview, is newer than
// stable, has green CI and canary, has fresh built folders, and asks for no
// more host access (or --ack-permissions says people will review it).
//
//   node scripts/release/promote.mjs <commit> [--dry-run] [--ack-permissions]
//     [--allow-unsoaked] [--canary-verified] [--status gh|<file.json>]
//     [--remote origin] [--notes-out file] [--github-release] [--date YYYYMMDD]
//
// Run it from a clone. The release workflow (.github/workflows/release.yml)
// calls it after running the canary against the commit.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  accessGrowth, buzzRevision, checkSteps, cli, fetchChannels, git, isAncestor, isBuildCheck, mergedPullRequests, onFirstParent,
  nextTag, parseArgs, pluginsAt, refuse, releaseNotes, releaseTags, repoSlug, resolveCommit, rolledBack, showFile,
  tagCommit, today,
} from "./lib.mjs";

const REQUIRED_CI = "required"; // the aggregate job in .github/workflows/ci.yml
const CANARY = /Buzz release /; // the canary job for the Buzz that Update installs now

/** Check-run conclusions on a commit: { name: conclusion }. */
export function readStatuses(source, sha, slug) {
  if (source === "skip") return null;
  if (source && source !== "gh") {
    let all = {};
    try { all = JSON.parse(readFileSync(source, "utf8")); } catch {}
    return all[sha] ?? {};
  }
  if (!slug) refuse("cannot tell which GitHub repository to read checks from; set GITHUB_REPOSITORY.");
  const text = execFileSync("gh", ["api", "--paginate", `repos/${slug}/commits/${sha}/check-runs?per_page=100`, "-q", ".check_runs[] | [.name, (.conclusion // .status)] | @tsv"], { encoding: "utf8" });
  const out = {};
  for (const line of text.trim().split("\n").filter(Boolean)) {
    const [name, conclusion] = line.split("\t");
    if (!out[name] || conclusion === "success") out[name] = conclusion; // a re-run that passed counts
  }
  return out;
}

/** Runs the target commit's own build checks in a throwaway worktree. */
export function staleBuilds(cwd, sha) {
  const steps = checkSteps(showFile(cwd, sha, "package.json") ?? "{}").filter(isBuildCheck);
  if (!steps.length) return [];
  const dir = mkdtempSync(join(tmpdir(), "black4-release-"));
  const failed = [];
  try {
    git(cwd, ["worktree", "add", "--detach", "--quiet", dir, sha]);
    for (const step of steps) {
      try { execFileSync("sh", ["-c", step], { cwd: dir, stdio: "pipe" }); } catch (error) {
        failed.push({ step, output: String(error.stdout ?? "") + String(error.stderr ?? "") });
      }
    }
  } finally {
    git(cwd, ["worktree", "remove", "--force", dir], { allowFail: true });
    rmSync(dir, { recursive: true, force: true });
  }
  return failed;
}

export function promote(argv, { cwd = process.cwd(), log = console.log } = {}) {
  const args = parseArgs(argv, ["dry-run", "ack-permissions", "allow-unsoaked", "canary-verified", "github-release"]);
  const remote = args.remote ?? "origin";
  const wanted = args._[0];
  if (!wanted) refuse("name the commit to release, for example: promote.mjs 1a2b3c4.");
  const tips = fetchChannels(cwd, remote);
  const sha = resolveCommit(cwd, wanted);
  if (!sha) refuse(`${wanted} is not a commit in this repository.`);
  const short = sha.slice(0, 10);
  if (!tips.main || !isAncestor(cwd, sha, tips.main)) refuse(`${short} is not on main, so it cannot be released.`);
  if (!onFirstParent(cwd, sha, tips.main)) refuse(`${short} is a commit inside a merged branch, not one of main's own commits, so CI on main never tested it; release the merge commit instead.`);
  if (rolledBack(cwd).has(sha)) refuse(`${short} was rolled back; release a later commit that fixes it.`);
  if (!args["allow-unsoaked"] && !(tips.preview && isAncestor(cwd, sha, tips.preview))) {
    refuse(`${short} has not reached preview yet, so nobody has run it; wait for the preview move or pass --allow-unsoaked.`);
  }
  if (tips.stable === sha) refuse(`${short} is already stable.`);
  if (tips.stable && !isAncestor(cwd, tips.stable, sha)) {
    refuse(`${short} is not newer than stable (${tips.stable.slice(0, 10)}); moving stable there is a rollback, so use rollback.mjs.`);
  }

  const slug = repoSlug(cwd, remote);
  const checks = readStatuses(args.status ?? "gh", sha, slug);
  if (checks) {
    if (checks[REQUIRED_CI] !== "success") refuse(`CI on ${short} is ${checks[REQUIRED_CI] ?? "missing"}, not green; fix or re-run it first.`);
    const canary = Object.entries(checks).filter(([name]) => CANARY.test(name));
    if (!args["canary-verified"] && !canary.some(([, c]) => c === "success")) {
      refuse(`the Buzz canary has not passed on ${short} against the current Buzz release; run the release workflow, which runs it first.`);
    }
  }

  const stale = staleBuilds(cwd, sha);
  if (stale.length) refuse(`the built plugin folders at ${short} are stale (${stale.map((s) => s.step).join("; ")}); rebuild them on main and release that commit.`);

  const growth = tips.stable ? accessGrowth(cwd, tips.stable, sha) : [];
  if (growth.length && !args["ack-permissions"]) {
    refuse(`${growth.map((g) => `${g.id} adds ${g.added.join(", ")}`).join("; ")}, so every person must review permissions before updating; pass --ack-permissions to release it anyway.`);
  }

  const date = args.date ?? today();
  let previousTag = [...releaseTags(cwd)].reverse().find((t) => tagCommit(cwd, t) === tips.stable) ?? null;
  // The first release through this script: tag stable as it is now too, so
  // there is a release to roll back to.
  const baseline = tips.stable && !previousTag ? nextTag(cwd, "release", date) : null;
  if (baseline) previousTag = baseline;
  const tag = baseline ? `release-${date}-${Number(baseline.split("-")[2]) + 1}` : nextTag(cwd, "release", date);
  const before = tips.stable ? pluginsAt(cwd, tips.stable) : {};
  const after = pluginsAt(cwd, sha);
  for (const info of Object.values(after)) info.revision = buzzRevision(info);
  const changed = Object.keys(after).filter((dir) => !before[dir] || buzzRevision(before[dir]) !== after[dir].revision || before[dir].manifest !== after[dir].manifest);
  const notes = releaseNotes({
    tag, commit: sha, previous: tips.stable, previousTag,
    prs: mergedPullRequests(cwd, tips.stable, sha), plugins: after, changed, access: growth,
    repoUrl: slug ? `https://github.com/${slug}` : null,
  });
  if (args["notes-out"]) writeFileSync(args["notes-out"], notes);
  log(notes);

  const from = tips.stable ? tips.stable.slice(0, 10) : "nowhere (first release)";
  if (args["dry-run"]) {
    log(`Dry run: would ${baseline ? `tag today's stable ${baseline} as a baseline, ` : ""}tag ${tag} at ${short} and move stable from ${from} to ${short}. Nothing was pushed.`);
    return { tag, baseline, sha, notes, dryRun: true };
  }
  const tags = [tag];
  if (baseline) {
    git(cwd, ["tag", "-a", baseline, "-m", `${baseline}\n\nBaseline: stable as it was before the first release made with promote.mjs.\n`, tips.stable]);
    tags.push(baseline);
  }
  git(cwd, ["tag", "-a", tag, "-F", "-", sha], { input: notes });
  try {
    git(cwd, ["push", "--atomic", `--force-with-lease=refs/heads/stable:${tips.stable ?? ""}`, remote, ...tags.map((t) => `refs/tags/${t}`), `${sha}:refs/heads/stable`]);
  } catch (error) {
    for (const t of tags) git(cwd, ["tag", "-d", t], { allowFail: true });
    refuse(`pushing stable and ${tag} failed, so nothing changed (${error.message.split("\n").pop()}).`);
  }
  if (args["github-release"] && slug) {
    const file = join(mkdtempSync(join(tmpdir(), "black4-notes-")), "notes.md");
    writeFileSync(file, notes);
    execFileSync("gh", ["release", "create", tag, "--repo", slug, "--verify-tag", "--title", tag, "--notes-file", file], { stdio: "inherit" });
  }
  log(`Released ${tag}: stable moved from ${from} to ${short}. Buzz offers it within the hour, or at once with Check again.`);
  return { tag, baseline, sha, notes, dryRun: false };
}

if (import.meta.url === `file://${process.argv[1]}`) cli(() => promote(process.argv.slice(2)));
