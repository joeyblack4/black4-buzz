#!/usr/bin/env node
// Black 4 Buzz canary, part 2: start the three plugins in a real Buzz checkout.
//
//   node canary/load.mjs <block/buzz-app checkout with its dependencies installed>
//
// Install Buzz's dependencies first (about 15 s, no build):
//   (cd <checkout> && pnpm install --frozen-lockfile --ignore-scripts)
// This copies canary/load/load.test.tsx and each plugins/*/plugin.js into
// <checkout>/src/__black4_canary__/, runs it with Buzz's own vitest, and
// removes the folder again. Exit 0: every plugin started and rendered.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const repo = resolve(here, "..");
const buzz = process.argv[2] ? resolve(process.argv[2]) : undefined;
if (!buzz || !existsSync(join(buzz, "src/app/services.ts"))) {
  console.error("Usage: node canary/load.mjs <block/buzz-app checkout with dependencies installed>");
  process.exit(2);
}
if (!existsSync(join(buzz, "node_modules/vitest"))) {
  console.error(`Buzz's dependencies are not installed in ${buzz}. Run there: pnpm install --frozen-lockfile --ignore-scripts`);
  process.exit(2);
}

const contract = JSON.parse(readFileSync(join(here, "contract.json"), "utf8"));
const dir = join(buzz, "src/__black4_canary__");
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const list = [];
for (const [id, plugin] of Object.entries(contract.plugins)) {
  const file = `${id.replace(/[^a-z0-9]+/gi, "-")}.js`;
  cpSync(join(repo, plugin.dir, "plugin.js"), join(dir, file));
  list.push({ id, title: plugin.title, file });
}
writeFileSync(join(dir, "plugins.json"), `${JSON.stringify(list, null, 2)}\n`);
cpSync(join(here, "load/load.test.tsx"), join(dir, "load.test.tsx"));

let status = 1;
try {
  const run = spawnSync("pnpm", ["exec", "vitest", "run", "src/__black4_canary__/", "--reporter=verbose"], {
    cwd: buzz,
    stdio: "inherit",
    env: { ...process.env, CI: "true" },
  });
  status = run.status ?? 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
if (status !== 0) console.error("\nAt least one Black 4 plugin does not start or render in this Buzz. The failing test above names the plugin and what it threw.");
process.exit(status);
