#!/usr/bin/env node
// The agent tools the Black 4 plugin hands Buzz, as Buzz fingerprints them.
//
// Buzz keys each Claude session on addedKey(): FNV-1a over every plugin tool's
// { name, description, inputSchema }, sorted by name (Buzz v1.0.5
// src/buzz-mcp/session-tools.ts, used in src/bundled/claude-code/runtime.ts
// `fingerprint`). When it changes, idle sessions start over. The tools
// themselves come from the Black 4 MCP at run time, but the plugin rewrites
// them on the way: a "black4_" prefix, a "Black 4: " description, the MCP's
// instructions on whoami, a note and a relaxed schema on
// resolve_channel_business, tools it never offers, and a length limit. This
// runs a plugin.js against one fixed tools/list from the fake MCP in
// tests/fakes.mjs and prints the tools and the key, so a pull request that
// changes any of that rewriting shows up before it restarts anyone's agents.
//
//   node scripts/tool-surface.mjs <plugin.js>            prints JSON
//   node scripts/tool-surface.mjs <base.js> <head.js>    compares, exit 3 when it differs
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// A fixed, fictional tools/list: covers each rewrite the plugin does.
export const FIXTURE_TOOLS = [
  { name: "whoami", description: "Who you are signed in as.", inputSchema: { type: "object", properties: {} } },
  { name: "resolve_channel_business", description: "Which business a channel belongs to.", inputSchema: { type: "object", properties: { channelId: { type: "string" }, communityId: { type: "string" } }, required: ["channelId"] } },
  { name: "open_review", title: "Open a review", inputSchema: { type: "object", properties: { businessId: { type: "string" } }, required: ["businessId"] } },
  { name: "list_reviews", description: "Reviews waiting.", inputSchema: { type: "array" } },
  { name: "renew_signin", description: "Never offered to agents.", inputSchema: { type: "object" } },
  { name: "sign_hardware_request", description: "Approval gated.", inputSchema: { type: "object", properties: { ownerKey: { type: "string" } } } },
  { name: "long_description", description: "x".repeat(8010), inputSchema: { type: "object" } },
];

/** Buzz's addedKey (session-tools.ts), byte for byte. */
export function addedKey(tools) {
  if (!tools.length) return "";
  const text = JSON.stringify(tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })).sort((a, b) => (a.name < b.name ? -1 : 1)));
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return (hash >>> 0).toString(36);
}

/** In a child process with BLACK4_TEST_PLUGIN set: start the plugin signed in and list its tools. */
async function child() {
  const fakes = await import(new URL("../tests/fakes.mjs", import.meta.url));
  const { apply, signInStore } = await fakes.freshPlugin();
  const authkit = fakes.fakeAuthKit();
  const mcp = fakes.fakeMcp(authkit, {
    instructions: "Fixture instructions.",
    answer: (message) => {
      if (message.method === "tools/list") return { result: { tools: FIXTURE_TOOLS } };
      if (message.params?.name === "whoami") return { result: { content: [{ type: "text", text: '{"kind":"customer","email":"person@example.test"}' }] } };
      return { result: { content: [{ type: "text", text: "{}" }] } };
    },
  });
  const net = fakes.https({ authkit, mcp });
  await signInStore.save(authkit.issue().refresh_token);
  const tools = new Map();
  const noop = () => () => {};
  let cleanup = null;
  // Any service the plugin asks for that this harness does not model answers with no-ops.
  const loose = (known = {}) => new Proxy(known, { get: (t, k) => (k in t ? t[k] : typeof k === "string" ? noop : undefined) });
  const h = (type, props, ...children) => ({ type, props: { ...(props ?? {}), children }, children });
  const ctx = new Proxy({
    react: { createElement: h, useState: (v) => [v, () => {}], useEffect: () => {}, useLayoutEffect: () => {}, useRef: (v) => ({ current: v }), useId: () => "id", useMemo: (f) => f(), useCallback: (f) => f, useSyncExternalStore: (s, g) => g(), Fragment: "fragment", Component: class {} },
    agents: loose({ snapshot: () => ({ running: [] }), addTool: (tool) => { tools.set(tool.name, tool); return () => tools.delete(tool.name); }, register: noop, addInstructions: noop }),
    host: loose({ request: net.request }),
    browser: { available: false, View: "browser-view" },
    pluginOwner: { id: "ai.black4", revision: "fixture" },
    effect: (fn) => { const off = fn(); if (typeof off === "function") cleanup = off; },
  }, { get: (t, k) => (k in t ? t[k] : typeof k === "string" ? loose() : undefined) });
  apply(ctx);
  await fakes.until(() => tools.size > 0, { timeoutMs: 5000, what: "the plugin to register its tools" });
  await fakes.settle(50);
  const listed = [...tools.values()].map(({ name, description, inputSchema }) => ({ name, description, inputSchema })).sort((a, b) => (a.name < b.name ? -1 : 1));
  cleanup?.();
  process.stdout.write(JSON.stringify({ key: addedKey(listed), tools: listed }));
  process.exit(0);
}

/** The tool surface of a plugin.js file, or { error }. */
export function surface(pluginFile) {
  try {
    const out = execFileSync(process.execPath, [fileURLToPath(import.meta.url), "--child"], {
      env: { ...process.env, BLACK4_TEST_PLUGIN: pluginFile }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000,
    });
    return JSON.parse(out);
  } catch (error) {
    return { error: String(error.stderr || error.message).trim().split("\n").slice(-3).join(" ") };
  }
}

/** What changed between two surfaces, one line each. */
export function compare(base, head) {
  const lines = [];
  const b = new Map(base.tools.map((t) => [t.name, t]));
  const n = new Map(head.tools.map((t) => [t.name, t]));
  for (const name of n.keys()) if (!b.has(name)) lines.push(`added ${name}`);
  for (const name of b.keys()) if (!n.has(name)) lines.push(`removed ${name}`);
  for (const [name, t] of n) {
    const o = b.get(name);
    if (!o) continue;
    if (o.description !== t.description) lines.push(`${name}: description changed`);
    if (JSON.stringify(o.inputSchema) !== JSON.stringify(t.inputSchema)) lines.push(`${name}: input schema changed`);
  }
  return lines;
}

if (process.argv.includes("--child")) {
  await child();
} else if (import.meta.url === `file://${process.argv[1]}`) {
  const [a, b] = process.argv.slice(2);
  const base = surface(a);
  if (!b) { console.log(JSON.stringify(base, null, 2)); process.exit(base.error ? 1 : 0); }
  const head = surface(b);
  if (base.error || head.error) { console.log(`Could not compare: ${base.error ?? head.error}`); process.exit(2); }
  const lines = compare(base, head);
  if (base.key === head.key) { console.log(`Same tools for agents (Buzz key ${head.key}).`); process.exit(0); }
  console.log(`Buzz key ${base.key} -> ${head.key}:\n${lines.map((l) => `- ${l}`).join("\n")}`);
  process.exit(3);
}
