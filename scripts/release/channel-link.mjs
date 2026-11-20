#!/usr/bin/env node
// Prints the link that moves an installed plugin to another channel without
// removing it. Buzz treats a buzz://plugin-install link pinned to a commit and
// a folder as an update of the plugin already installed from that repository
// and folder, and saves the link's ref for later updates (Buzz v1.0.5,
// src/app/PluginImport.tsx `pinnedLink`, docs/deep-links.md). A plain link, or
// Install from GitHub, says "Already installed" instead.
//
//   node scripts/release/channel-link.mjs preview [--plugin black4]
//   node scripts/release/channel-link.mjs stable  [--plugin claude-subscription]
import { cli, git, parseArgs, refuse } from "./lib.mjs";

export function channelLink(channel, plugin, commit, repository = "joeyblack4/black4-buzz") {
  const q = (v) => encodeURIComponent(v);
  return `buzz://plugin-install?repository=${q(repository)}&ref=${q(channel)}&path=${q(`plugins/${plugin}`)}&commit=${commit}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cli(() => {
    const args = parseArgs(process.argv.slice(2));
    const channel = args._[0];
    if (!["stable", "preview"].includes(channel)) refuse("name a channel: stable or preview.");
    const repository = args.repository ?? "joeyblack4/black4-buzz";
    const line = git(process.cwd(), ["ls-remote", `https://github.com/${repository}.git`, `refs/heads/${channel}`]);
    const commit = line.split("\t")[0];
    if (!/^[0-9a-f]{40}$/.test(commit)) refuse(`${repository} has no ${channel} branch yet.`);
    console.log(channelLink(channel, args.plugin ?? "black4", commit, repository));
    console.log(`\nOpen it on the Mac (open '<link>'), check the review says later updates follow ${channel}, and choose Update.`);
    console.log("If Buzz says the plugin is up to date, the two channels hold the same plugin today: the link changes nothing until they differ.");
  });
}
