// Buzz installs a plugin folder as it is and never runs a build. Each folder
// under plugins/ may hold only what Buzz reads, so nothing else ships.
import { readdirSync, readFileSync } from "node:fs";

const ALLOWED = new Set(["manifest.json", "plugin.js", "README.md", "icon.png", "icon.jpg"]);
let failed = false;
for (const plugin of readdirSync("plugins", { withFileTypes: true })) {
  if (!plugin.isDirectory()) continue;
  const dir = `plugins/${plugin.name}`;
  const files = readdirSync(dir);
  for (const required of ["manifest.json", "plugin.js"]) {
    if (!files.includes(required)) { console.error(`${dir}: missing ${required}`); failed = true; }
  }
  for (const file of files) {
    if (!ALLOWED.has(file)) { console.error(`${dir}: ${file} does not belong in a Buzz plugin folder`); failed = true; }
  }
  const manifest = JSON.parse(readFileSync(`${dir}/manifest.json`, "utf8"));
  if (manifest.apiVersion !== 1 || !/^[a-z][a-z0-9.-]*$/.test(manifest.id ?? "")) {
    console.error(`${dir}: manifest needs apiVersion 1 and a valid id`); failed = true;
  }
  // Without this declaration Buzz never checks a Git-installed plugin for updates.
  if (manifest.updates?.defaultEnabled !== true) {
    console.error(`${dir}: manifest needs "updates": { "defaultEnabled": true }`); failed = true;
  }
}
process.exit(failed ? 1 : 0);
