// canary/contract.json must list every Buzz API the plugins touch, or the
// canary checks less than the plugins use. This reads each plugin.js for
// `ctx.<service>.<member>` (and the plugin's own aliases for ctx services,
// such as `kit` for ctx.agents.harness) and requires the contract to name it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const contract = JSON.parse(readFileSync(new URL("canary/contract.json", root), "utf8"));

/** Every path the contract names, and every prefix of it, in ctx dot form. */
function named(spec) {
  const paths = [...(spec.uses ?? []), ...Object.keys(spec.provides ?? {}), ...Object.keys(spec.accepts ?? {}), ...(spec.inject ?? [])];
  const out = new Set();
  for (const path of paths) {
    const plain = path.replace(/\(\d+\)|=>|\[\]/g, ".").split(".").filter(Boolean);
    for (let i = 1; i <= plain.length; i++) out.add(plain.slice(0, i).join("."));
  }
  return out;
}

/** What plugin.js touches on ctx: ctx.a, ctx.a.b, and alias.b as base.b. */
function touched(source, aliases) {
  const out = new Set();
  for (const [, service, member] of source.matchAll(/\bctx\??\.(\w+)(?:\??\.(\w+))?/g)) {
    out.add(member ? `${service}.${member}` : service);
  }
  for (const [alias, base] of Object.entries(aliases ?? {})) {
    for (const [, member] of source.matchAll(new RegExp(`(?<![\\w.'"])${alias}\\??\\.(\\w+)`, "g"))) out.add(`${base}.${member}`);
  }
  return out;
}

for (const [id, raw] of Object.entries(contract.plugins)) {
  const spec = raw.sameAs ? { ...contract.plugins[raw.sameAs], ...raw } : raw;
  test(`canary contract covers what ${id} uses`, () => {
    const source = readFileSync(new URL(`${spec.dir}/plugin.js`, root), "utf8");
    const known = named(spec);
    const missing = [...touched(source, spec.aliases)].filter((path) => !known.has(path));
    assert.deepEqual(missing, [], `${spec.dir}/plugin.js uses ${missing.map((path) => `ctx.${path}`).join(", ")}, which canary/contract.json does not list for ${id}`);
  });

  test(`canary contract's inject list for ${id} matches plugin.js`, () => {
    const source = readFileSync(new URL(`${spec.dir}/plugin.js`, root), "utf8");
    const inject = JSON.parse(source.match(/export const inject = (\[[^\]]*\])/)[1]);
    assert.deepEqual([...inject].sort(), [...spec.inject].sort());
  });
}
