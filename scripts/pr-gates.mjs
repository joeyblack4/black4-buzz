#!/usr/bin/env node
// What a pull request does to the people who run these plugins, said in one
// sentence each, in the check's output and its summary:
//
// - stale built folders: fails (a release from it would ship old code);
// - more host access in a manifest: flags, does not fail (every person will be
//   asked to review permissions when it is released);
// - a change to the tools agents see: fails unless the pull request carries
//   the label `restarts-agent-sessions` (Buzz starts idle agent sessions over
//   when a tool's name, description or schema changes);
// - which plugins people will be offered as an update.
//
//   node scripts/pr-gates.mjs <base-commit> [<head-commit>]
// Labels come from PR_LABELS (comma separated); the summary goes to
// GITHUB_STEP_SUMMARY when set.
import { execSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addedAccess, accessSignatures, buzzRevision, checkSteps, isBuildCheck, pluginsAt, resolveCommit, showFile } from "./release/lib.mjs";
import { compare, surface } from "./tool-surface.mjs";

const LABEL = "restarts-agent-sessions";
const cwd = process.cwd();
const base = resolveCommit(cwd, process.argv[2] ?? "");
const head = resolveCommit(cwd, process.argv[3] ?? "HEAD");
if (!base || !head) { console.error("usage: pr-gates.mjs <base-commit> [<head-commit>] (fetch the base first)"); process.exit(2); }
const labels = (process.env.PR_LABELS ?? "").split(",").map((l) => l.trim()).filter(Boolean);
const annotate = !!process.env.GITHUB_ACTIONS;
const summary = ["## What this pull request does to people's Buzz", ""];
let failed = false;
const say = (level, sentence) => {
  console.log(`${level === "error" ? "FAIL" : level === "warning" ? "FLAG" : "note"}: ${sentence}`);
  if (annotate) console.log(`::${level}::${sentence}`);
  summary.push(`- ${level === "error" ? "❌" : level === "warning" ? "⚠️" : "ℹ️"} ${sentence}`);
  if (level === "error") failed = true;
};

// 1. Built folders match their source (in this checkout, which is head).
for (const step of checkSteps(readFileSync("package.json", "utf8")).filter(isBuildCheck)) {
  try { execSync(step, { stdio: "pipe" }); } catch {
    say("error", `A built folder is stale (\`${step}\` failed): rebuild it (for example \`npm run kit\` or \`npm run build --prefix subscriptions\`) and commit the result.`);
  }
}

// 2. Host access, as Buzz's update review judges it.
const before = pluginsAt(cwd, base);
const after = pluginsAt(cwd, head);
for (const [dir, next] of Object.entries(after)) {
  const id = JSON.parse(next.manifest).id;
  if (!before[dir]) { say("notice", `${id} is a new plugin folder (${dir}); people install it themselves.`); continue; }
  const prev = JSON.parse(before[dir].manifest);
  const added = addedAccess(prev, JSON.parse(next.manifest));
  if (added.length) say("warning", `${id} asks for more access (${added.join("; ")}), so every person will have to review permissions before this update installs.`);
  else if (JSON.stringify(accessSignatures(prev)) !== JSON.stringify(accessSignatures(JSON.parse(next.manifest)))) say("notice", `${id} gives up some host access; updates install without a review.`);
}

// 3. Plugins whose content changes: what a release from here offers.
const changed = Object.keys(after).filter((dir) => before[dir] && (buzzRevision(before[dir]) !== buzzRevision(after[dir]) || before[dir].manifest !== after[dir].manifest));
if (changed.length) say("notice", `When released, Buzz offers Update and reload for ${changed.map((d) => JSON.parse(after[d].manifest).id).join(", ")}; each reload stops that plugin for a moment.`);
else say("notice", "No plugin folder changes, so a release from here offers nobody an update.");

// 4. The tools agents see.
const pluginPath = "plugins/black4/plugin.js";
if (showFile(cwd, base, pluginPath) !== showFile(cwd, head, pluginPath)) {
  const dir = mkdtempSync(join(tmpdir(), "black4-tools-"));
  const files = [base, head].map((c, i) => { const f = join(dir, `${i}.js`); writeFileSync(f, showFile(cwd, c, pluginPath) ?? ""); return f; });
  const [a, b] = files.map(surface);
  if (a.error || b.error) say("warning", `Could not compare the tools agents see (${a.error ?? b.error}); check by hand whether a tool's name, description or schema changed.`);
  else if (a.key !== b.key) {
    const what = compare(a, b).join("; ");
    if (labels.includes(LABEL)) say("warning", `The tools agents see change (${what}), so Buzz will start idle agent sessions over after this release; the \`${LABEL}\` label accepts that.`);
    else say("error", `The tools agents see change (${what}), which makes Buzz start idle agent sessions over; add the \`${LABEL}\` label if that is intended.`);
  } else say("notice", `The tools agents see are unchanged (Buzz key ${b.key}).`);
}
summary.push("", "Tools also change when the Black 4 MCP changes its own tool list; that happens in black4-retail-edge, not here.");

if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary.join("\n") + "\n");
process.exit(failed ? 1 : 0);
