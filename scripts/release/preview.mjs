#!/usr/bin/env node
// Moves `preview` forward to a commit on main whose CI passed. Only forward:
// a run that finishes late, for a commit preview already holds or is past,
// changes nothing. .github/workflows/preview.yml calls it after each green CI
// run on main.
//
//   node scripts/release/preview.mjs <commit> [--dry-run] [--remote origin]
import { cli, fetchChannels, git, isAncestor, onFirstParent, parseArgs, refuse, resolveCommit } from "./lib.mjs";

export function movePreview(argv, { cwd = process.cwd(), log = console.log } = {}) {
  const args = parseArgs(argv, ["dry-run"]);
  const remote = args.remote ?? "origin";
  const tips = fetchChannels(cwd, remote);
  const sha = args._[0] && resolveCommit(cwd, args._[0]);
  if (!sha) refuse(`${args._[0] ?? "(none)"} is not a commit in this repository.`);
  const short = sha.slice(0, 10);
  if (!onFirstParent(cwd, sha, tips.main)) refuse(`${short} is not one of main's own commits, so it does not go to preview.`);
  if (tips.preview && isAncestor(cwd, sha, tips.preview)) {
    log(`preview (${tips.preview.slice(0, 10)}) already holds ${short}; nothing to do.`);
    return { moved: false };
  }
  if (tips.preview && !isAncestor(cwd, tips.preview, sha)) {
    refuse(`preview (${tips.preview.slice(0, 10)}) is not on main's history, so someone moved it by hand; reset it to a main commit first.`);
  }
  if (args["dry-run"]) {
    log(`Dry run: would move preview from ${tips.preview?.slice(0, 10) ?? "nowhere"} to ${short}.`);
    return { moved: false, dryRun: true };
  }
  git(cwd, ["push", `--force-with-lease=refs/heads/preview:${tips.preview ?? ""}`, remote, `${sha}:refs/heads/preview`]);
  log(`preview moved from ${tips.preview?.slice(0, 10) ?? "nowhere"} to ${short}.`);
  return { moved: true };
}

if (import.meta.url === `file://${process.argv[1]}`) cli(() => movePreview(process.argv.slice(2)));
