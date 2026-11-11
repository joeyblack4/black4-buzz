// Builds the two subscription plugins Buzz installs. Each is one
// self-contained plugin.js (the shared runtime plus its provider) and a
// manifest.json. Buzz never runs a build, so the output is committed;
// `--check` refuses a committed copy that no longer matches its source.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const here = new URL(".", import.meta.url);
const read = (path) => readFileSync(new URL(path, here), "utf8");
const PROVIDERS = [
  { provider: "claude", title: "Claude Sub Plugin", defaultModel: "opus", cli: "@anthropic-ai/claude-code" },
  { provider: "grok", title: "Grok Sub Plugin", defaultModel: "grok-4.6", cli: "@xai-official/grok" },
];
const check = process.argv.includes("--check");
const common = read("src/common.js");
let stale = false;
for (const { provider, title, defaultModel, cli } of PROVIDERS) {
  const name = provider[0].toUpperCase() + provider.slice(1);
  const spec = JSON.stringify({ provider, title, defaultModel }).replace(/":/g, '": ').replace(/,"/g, ', "');
  const plugin = `export const inject = ["agents", "host", "react"];\nexport function apply(ctx) {\nconst spec = ${spec};\n${common}\n${read(`src/${provider}.js`)}\n}\n`;
  const manifest = `${JSON.stringify({
    id: `black4.${provider}-subscription`,
    name: title,
    apiVersion: 1,
    description: `${name} subscription agents with personal sign-in, models, reasoning effort, coding and Buzz tools. Runs on your computer.`,
    updates: { defaultEnabled: true },
    host: {
      processes: [
        { id: provider, program: provider },
        { id: "install", program: "npm", args: ["install", "-g", cli] },
      ],
      mcp: true,
      files: true,
    },
  }, null, 2)}\n`;
  const out = new URL(`../plugins/${provider}-subscription/`, here);
  for (const [file, text] of [["plugin.js", plugin], ["manifest.json", manifest]]) {
    if (check) {
      let current = "";
      try { current = readFileSync(new URL(file, out), "utf8"); } catch {}
      if (current !== text) { console.error(`plugins/${provider}-subscription/${file} is stale: run npm run build --prefix subscriptions`); stale = true; }
    } else {
      mkdirSync(out, { recursive: true });
      writeFileSync(new URL(file, out), text);
    }
  }
}
process.exit(stale ? 1 : 0);
