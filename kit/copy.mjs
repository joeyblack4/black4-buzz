#!/usr/bin/env node
// Copies, word for word, the Buzz rules and avatars the kit's agent parts
// need from a Buzz (block/buzz-app) checkout into kit/buzz-ui.js:
//
//   node kit/copy.mjs <block/buzz-app checkout>   then npm run kit
//
// Buzz's agent cards and profile are drawn with CSS-module classes, which
// Buzz renames on every build, so a plugin cannot use them. The kit keeps
// Buzz's own rules under its own class names (`b4copy-<file>-<class>`), and
// canary/design.mjs checks every day that each copied rule is still in Buzz,
// unchanged. Change the list below, never the copied text.
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Buzz file → the kit's name for it and the rules taken, by selector. */
export const TAKEN = {
  "src/bundled/agents/AgentCard.module.css": { prefix: "card", rules: [".grid", ".slot", ".card", ".agentCard", ".identity",
    '.card:is([role="option"], [role="gridcell"])', '.card:is([aria-selected="true"], [data-selected="true"])',
    '.agentCard:is([aria-selected="true"], [data-selected="true"])', "html[data-keyboard-navigation] .card:focus-visible", ".portrait",
    '.portrait > [class~="buzz-avatar-status"]', ".card[data-unavailable] .portrait", ".portrait > :is(img, video)", ".name", ".identity .name",
    '.agentCard .portrait:has(> [class~="buzz-avatar-status"])', '.agentCard .portrait > [class~="buzz-avatar-status"]', ".detail",
    ".agentCard .detail", ".detailText", ".actions", ".menu", ".bestie"] },
  "src/bundled/agents/AgentsPage.module.css": { prefix: "page", rules: [".browse", ".browse[data-side]", ".main", ".inventory", ".side", ".build",
    ".detailsScroll", ".identityPortrait", '.identityCard > :is([aria-hidden="true"], .identityPortrait)', ".identityCard > .identityPortrait",
    ".work", ".content", ".nameActions", ".identityName", ".nameEditor"] },
  "src/features/profiles/ProfileHero.module.css": { prefix: "hero", rules: [".hero", ".actions", ".avatarBackdrop", ".avatarBackdropImage",
    ".panelHero", ".panelHero:first-child", ".hero :is(h2, h3)"] },
  "src/features/panels/Panels.module.css": { prefix: "panels", rules: [".workspace", ".workspace > header", ".workspaceBody", ".workspacePane"] },
};
export const CATALOG = "src/features/agents/avatar-packs/catalog.json";

/** A stylesheet without comments or @reference/@import lines. */
export const bare = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^@(reference|import)[^;]*;/gm, "");
/** Whitespace made one space, for comparing rules. */
export const flat = (css) => css.replace(/\s+/g, " ").replace(/\s*([{};:,()])\s*/g, "$1").trim();

/** Top-level blocks: { head, body, text }. */
export function blocks(css) {
  const out = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf("{", i);
    if (open < 0) break;
    let depth = 1, j = open + 1;
    while (depth && j < css.length) { if (css[j] === "{") depth++; else if (css[j] === "}") depth--; j++; }
    out.push({ head: css.slice(i, open).trim(), body: css.slice(open + 1, j - 1), text: css.slice(i, j).trim() });
    i = j;
  }
  return out;
}

/** The rules taken from one Buzz stylesheet (an @media block keeps only the taken rules inside it). */
export function take(css, selectors) {
  const wanted = new Set(selectors);
  const rules = [];
  for (const block of blocks(bare(css))) {
    if (/^@(media|container)/.test(block.head)) {
      const inner = blocks(block.body).filter((rule) => wanted.has(rule.head)).map((rule) => rule.text);
      if (inner.length) rules.push(`${block.head} {\n${inner.join("\n")}\n}`);
    } else if (wanted.has(block.head)) rules.push(block.text);
  }
  return rules;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const buzz = process.argv[2] && resolve(process.argv[2]);
  if (!buzz) { console.error("Usage: node kit/copy.mjs <block/buzz-app checkout>"); process.exit(2); }
  const label = execFileSync("git", ["-C", buzz, "describe", "--tags", "--always"], { encoding: "utf8" }).trim();
  const copied = Object.entries(TAKEN).map(([file, { prefix, rules: selectors }]) => {
    const rules = take(readFileSync(join(buzz, file), "utf8"), selectors);
    const found = new Set(rules.flatMap((rule) => blocks(rule.startsWith("@") ? blocks(rule)[0].body : rule).map((block) => block.head)));
    const lost = selectors.filter((selector) => !found.has(selector));
    if (lost.length) { console.error(`${file} no longer has ${lost.join(", ")}`); process.exit(1); }
    return { file, prefix, rules };
  });
  const catalog = JSON.parse(readFileSync(join(buzz, CATALOG), "utf8"));
  const avatars = catalog.assets.map((asset) => ({ id: asset.id, label: asset.label, url: asset.url,
    webm: asset.animations?.webm?.url, hevc: asset.animations?.hevc?.url }));
  const kit = new URL("buzz-ui.js", import.meta.url);
  const BEGIN = "  // ---- copied from Buzz by kit/copy.mjs; the canary checks it; never edit it here ----";
  const END = "  // ---- end copied from Buzz ----";
  const source = readFileSync(kit, "utf8");
  const at = source.indexOf(BEGIN), to = source.indexOf(END);
  if (at < 0 || to < 0) { console.error("kit/buzz-ui.js has no copied-from-Buzz markers"); process.exit(1); }
  const block = `${BEGIN}\n  const COPIED_FROM = ${JSON.stringify(label)};\n  const COPIED = ${JSON.stringify(copied, null, 1).replace(/\n/g, "\n  ")};\n  const AVATARS = ${JSON.stringify(avatars).replace(/\},\{/g, "},\n    {")};\n`;
  writeFileSync(kit, source.slice(0, at) + block + source.slice(to));
  console.log(`Copied ${copied.reduce((n, file) => n + file.rules.length, 0)} rules and ${avatars.length} avatars from Buzz ${label}.`);
}
