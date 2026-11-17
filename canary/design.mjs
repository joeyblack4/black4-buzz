#!/usr/bin/env node
// Black 4 Buzz canary, part 3: does a Buzz (block/buzz-app) checkout still
// paint the Buzz UI kit the way it paints its own screens?
//
//   node canary/design.mjs <block/buzz-app checkout> [--label v1.0.4]
//
// kit/uses.json lists every Buzz class, data attribute, Tailwind utility and
// custom property the kit draws with. Each must still be in that Buzz:
// - a `buzz-*` class in Buzz's stylesheets or its design-system components;
// - a data attribute (with its value) in a stylesheet rule or in Buzz's
//   design-system components;
// - a Tailwind utility in Buzz's own sources. Tailwind writes only the
//   utilities Buzz's code uses, never a plugin's, so one Buzz stops using is
//   gone from the app even though nothing was renamed;
// - a custom property read by a stylesheet.
// Exit 0: unchanged. Exit 1: one sentence per entry Buzz no longer has.
// Exit 2: the canary could not run.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const labelAt = args.indexOf("--label");
let label = labelAt >= 0 ? args.splice(labelAt, 2)[1] : undefined;
const buzz = args[0] ? resolve(args[0]) : undefined;
const ui = buzz && join(buzz, "src/shared/design-system/ui");
if (!buzz || !existsSync(ui)) {
  console.error(`Usage: node canary/design.mjs <block/buzz-app checkout>${buzz ? `\n${buzz} has no src/shared/design-system/ui: Buzz moved its design system, so the canary needs updating.` : ""}`);
  process.exit(2);
}
try { label ??= execFileSync("git", ["-C", buzz, "describe", "--tags", "--always"], { encoding: "utf8" }).trim(); } catch { label ??= buzz; }

const uses = JSON.parse(readFileSync(new URL("../kit/uses.json", import.meta.url), "utf8"));
const files = (dir, test, out = []) => {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files(path, test, out);
    else if (test(name)) out.push(path);
  }
  return out;
};
const text = (paths) => paths.map((path) => readFileSync(path, "utf8")).join("\n");
const css = text(files(join(buzz, "src"), (name) => name.endsWith(".css")));
const componentFiles = files(ui, (name) => /\.tsx?$/.test(name) && !/\.test\./.test(name))
  // Comments say what a component did once; only its code counts.
  .map((path) => readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1"));
const components = componentFiles.join("\n");
const sources = text(files(join(buzz, "src"), (name) => /\.(tsx?|jsx?|html|mdx?)$/.test(name)));
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const problems = [];
let checks = 0;
const missing = (what, why) => problems.push(`The Buzz UI kit draws with ${what}, but Buzz ${label} ${why}. Read how Buzz draws it now, change kit/buzz-ui.js and kit/uses.json to match, then run npm run kit.`);

for (const name of uses.classes) {
  checks++;
  const pattern = new RegExp(`\\.${escape(name)}(?![\\w-])`);
  const inComponents = new RegExp(`["'\` ]${escape(name)}(?![\\w-])`);
  if (!pattern.test(css) && !inComponents.test(components)) missing(`the class ${name}`, "no longer has it in its stylesheets or design-system components");
}
for (const entry of uses.attributes) {
  checks++;
  const [, owner, key, value] = entry.match(/^([^[]+)\[([^=\]]+)(?:="([^"]*)")?\]$/);
  const where = owner === "*" ? "" : ` on ${owner}`;
  const selector = value === undefined
    ? new RegExp(`\\[${escape(key)}(?:[\\]=~|^$*])`)
    : new RegExp(`\\[${escape(key)}=["']?${escape(value)}["']?\\]`);
  // A component sets it: the attribute, and the value as one of its literals
  // (Buzz sets most from a prop: data-variant={variant}, variant = "default").
  const component = componentFiles.some((file) => new RegExp(`["']?${escape(key)}["']?\\s*[:=]`).test(file)
    && (value === undefined || value === "" || new RegExp(`["'\`]${escape(value)}["'\`]`).test(file)));
  if (!selector.test(css) && !component) {
    missing(`${value === undefined ? key : `${key}="${value}"`}${where}`, "neither styles it nor sets it in its design-system components");
  }
}
for (const name of uses.utilities) {
  checks++;
  const token = new RegExp(`(^|[\\s"'\`{])${escape(name)}(?=$|[\\s"'\`}])`, "m");
  const defined = new RegExp(`@utility\\s+${escape(name)}\\b|\\.${escape(name.replace(/:/g, "\\:"))}(?![\\w-])`);
  if (!token.test(sources) && !defined.test(css)) missing(`the utility ${name}`, "no longer uses it anywhere, so Tailwind leaves it out of Buzz's stylesheet");
}
for (const name of uses.customProperties) {
  checks++;
  if (!css.includes(`var(${name}`)) missing(`the custom property ${name}`, "no longer reads it in any stylesheet");
}

if (problems.length) {
  console.error(`Buzz ${label}: ${problems.length} of ${checks} design checks failed.`);
  for (const problem of problems) console.error(`- ${problem}`);
  process.exit(1);
}
console.log(`Buzz ${label}: the UI kit's ${checks} design checks pass.`);
