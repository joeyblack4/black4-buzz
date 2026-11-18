// Stamps the plugin's own source modules into plugins/black4/plugin.js, the
// way kit/build.mjs stamps the Buzz UI kit. Buzz runs no build, so the
// installed plugin stays one file and the stamped copy is committed;
// `--check` refuses one that no longer matches its sources.
//   node src/build.mjs [--check]
import { readFileSync, writeFileSync } from "node:fs";

/** Each module: its marker name and its source files, stamped in order. */
export const MODULES = [
  { name: "reviews", files: ["src/reviews/data.js", "src/reviews/ui.js", "src/reviews/part.js"] },
];
export const TARGET = "plugins/black4/plugin.js";
export const begin = (name) => `// ---- ${name}: stamped from src/${name}/ by \`npm run build\`; edit it there ----`;
export const end = (name) => `// ---- end ${name} ----`;

const root = new URL("..", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

/** `text` with the module's block replaced by `body`, or null without a block. */
export function stampModule(text, name, body) {
  const at = text.indexOf(begin(name));
  if (at < 0) return null;
  const stop = text.indexOf(end(name), at);
  if (stop < 0) throw new Error(`the ${name} block starts but never ends (${end(name)})`);
  return `${text.slice(0, at)}${begin(name)}\n${body.trimEnd()}\n${text.slice(stop)}`;
}
export const moduleBody = (module) => module.files.map((file) => read(file).trimEnd()).join("\n\n");

if (import.meta.url === `file://${process.argv[1]}`) {
  const check = process.argv.includes("--check");
  let text = read(TARGET);
  const original = text;
  for (const module of MODULES) {
    const next = stampModule(text, module.name, moduleBody(module));
    if (next === null) { console.error(`${TARGET} has no ${module.name} block (${begin(module.name)})`); process.exit(1); }
    text = next;
  }
  if (text === original) process.exit(0);
  if (check) { console.error(`${TARGET} holds an old copy of src/: run npm run build`); process.exit(1); }
  writeFileSync(new URL(TARGET, root), text);
  console.log(`stamped ${TARGET}`);
}
