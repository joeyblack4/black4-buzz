// Stamps kit/buzz-ui.js into every plugin that carries the kit markers.
// Buzz runs no build, so each plugin.js keeps its own copy and the copy is
// committed; `--check` refuses one that no longer matches the kit.
//   node kit/build.mjs [--check]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const BEGIN = "// ---- buzz-ui kit: stamped from kit/buzz-ui.js by `npm run kit`; edit it there ----";
export const END = "// ---- end buzz-ui kit ----";
/** Every file that holds the kit: built plugins and plugin sources. */
export const STAMPED = ["plugins/black4/plugin.js", "subscriptions/src/common.js"];

const root = new URL("..", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

/** `text` with its kit block replaced by `kit`, or null when it has no block. */
export function stamp(text, kit) {
  const begin = text.indexOf(BEGIN);
  if (begin < 0) return null;
  const end = text.indexOf(END, begin);
  if (end < 0) throw new Error(`a kit block starts but never ends (${END})`);
  return `${text.slice(0, begin)}${BEGIN}\n${kit.trimEnd()}\n${text.slice(end)}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const check = process.argv.includes("--check");
  const kit = read("kit/buzz-ui.js");
  let stale = false;
  for (const file of STAMPED) {
    let text;
    try { text = read(file); } catch { continue; }
    const next = stamp(text, kit);
    if (next === null || next === text) continue;
    if (check) { console.error(`${file} holds an old copy of the Buzz UI kit: run npm run kit`); stale = true; }
    else { writeFileSync(new URL(file, root), next); console.log(`stamped ${file}`); }
  }
  process.exit(stale ? 1 : 0);
}
