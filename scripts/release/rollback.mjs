#!/usr/bin/env node
// Undoes the current release: moves `stable` back to the previous release tag
// (or --to <release tag>) and records the move as a rollback-YYYYMMDD-N tag
// whose message names the commit undone, so promote.mjs never releases it
// again. Buzz compares plugin contents, not Git history, so every install on
// stable is offered the older plugin as an ordinary update within the hour.
//
//   node scripts/release/rollback.mjs [--to release-YYYYMMDD-N] [--dry-run]
//     [--ack-permissions] [--remote origin] [--date YYYYMMDD]
//
// main and preview keep the bad commit: land a fix (or a revert) on main.
import { accessGrowth, cli, fetchChannels, git, isAncestor, nextTag, parseArgs, refuse, releaseTags, tagCommit, today, RELEASE_TAG } from "./lib.mjs";

export function rollback(argv, { cwd = process.cwd(), log = console.log } = {}) {
  const args = parseArgs(argv, ["dry-run", "ack-permissions"]);
  const remote = args.remote ?? "origin";
  const tips = fetchChannels(cwd, remote);
  if (!tips.stable) refuse("there is no stable branch to roll back.");
  const tags = releaseTags(cwd);
  const current = [...tags].reverse().find((t) => tagCommit(cwd, t) === tips.stable) ?? null;
  let target;
  if (args.to) {
    if (!RELEASE_TAG.test(args.to) || !tags.includes(args.to)) refuse(`${args.to} is not a release tag; roll back only to a commit that was released.`);
    target = args.to;
  } else {
    const earlier = current ? tags.slice(0, tags.indexOf(current)) : tags;
    target = [...earlier].reverse().find((t) => tagCommit(cwd, t) !== tips.stable && isAncestor(cwd, tagCommit(cwd, t), tips.stable)) ?? null;
    if (!target) refuse("there is no earlier release to roll back to.");
  }
  const sha = tagCommit(cwd, target);
  if (sha === tips.stable) refuse(`stable is already at ${target}.`);
  const growth = accessGrowth(cwd, tips.stable, sha);
  if (growth.length && !args["ack-permissions"]) {
    refuse(`going back to ${target} gives ${growth.map((g) => `${g.id} ${g.added.join(", ")}`).join("; ")} again, so every person must review permissions; pass --ack-permissions to roll back anyway.`);
  }
  const tag = nextTag(cwd, "rollback", args.date ?? today());
  const message = `${tag}\n\nRolled back: ${tips.stable}\nFrom: ${current ?? "an untagged stable"}\nTo: ${target} (${sha})\n`;
  const short = (s) => s.slice(0, 10);
  if (args["dry-run"]) {
    log(`Dry run: would move stable from ${short(tips.stable)}${current ? ` (${current})` : ""} back to ${target} (${short(sha)}) and tag ${tag}. Nothing was pushed.`);
    return { tag, target, sha, dryRun: true };
  }
  git(cwd, ["tag", "-a", tag, "-F", "-", sha], { input: message });
  try {
    git(cwd, ["push", "--atomic", `--force-with-lease=refs/heads/stable:${tips.stable}`, remote, `+${sha}:refs/heads/stable`, `refs/tags/${tag}`]);
  } catch (error) {
    git(cwd, ["tag", "-d", tag], { allowFail: true });
    refuse(`pushing stable failed, so nothing changed (${error.message.split("\n").pop()}).`);
  }
  log(`Rolled back: stable moved from ${short(tips.stable)} to ${target} (${short(sha)}), recorded as ${tag}. Buzz offers it within the hour, or at once with Check again. main and preview still hold ${short(tips.stable)}: land a fix on main.`);
  return { tag, target, sha, dryRun: false };
}

if (import.meta.url === `file://${process.argv[1]}`) cli(() => rollback(process.argv.slice(2)));
