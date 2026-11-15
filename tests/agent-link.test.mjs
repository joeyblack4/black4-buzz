// The one-click agent link in the Black 4 Settings card: a process double for
// the bridge, fictional keys and people, no network.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../plugins/black4/plugin.js", import.meta.url), "utf8");
const { apply, readAnswer, linkLabel } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function settle() { for (let i = 0; i < 16; i++) await tick(); }

const VIEWER = "a".repeat(64);
const OTHER = "b".repeat(64);
const ok = (data) => ({ structuredContent: { data }, content: [{ type: "text", text: JSON.stringify(data) }] });
const refusal = (code, message) => ({ isError: true, content: [{ type: "text", text: JSON.stringify({ error: { code, message } }) }] });
const link = (ownerKey, extra = {}) => ({
  linkId: `link-${ownerKey.slice(0, 4)}`, ownerKey, email: "person@example.test", label: "Buzz on Mac",
  linkedAt: "2026-11-14T12:00:00.000Z", linkedBy: "person@example.test", lastUsedAt: null, revokedAt: null, revokedBy: null, agents: [], ...extra,
});

/** A Black 4 server holding links for one person. `listed` is what tools/list shows. */
function server({ listed = ["whoami", "find_tools", "call_tool"], links = [], refuseLink, offline } = {}) {
  const calls = [];
  const tools = { // the non-core tools, reached directly when listed, else through call_tool
    list_agent_owner_keys: () => ok({ links: links.filter((entry) => !entry.revokedAt) }),
    link_agent_owner_key: ({ ownerKey, label }) => {
      if (refuseLink) return refusal(...refuseLink);
      let entry = links.find((value) => value.ownerKey === ownerKey && !value.revokedAt);
      const created = !entry;
      if (!entry) links.push(entry = link(ownerKey, { label }));
      return ok({ link: entry, created });
    },
    revoke_agent_access: ({ linkId }) => {
      const entry = links.find((value) => value.linkId === linkId);
      entry.revokedAt = "2026-11-14T13:00:00.000Z";
      return ok({ revoked: "link", id: linkId, changed: true });
    },
  };
  const answer = (message) => {
    if (message.method === "initialize") return { result: {} };
    if (message.method === "tools/list") return { result: { tools: listed.map((name) => ({ name, inputSchema: { type: "object" } })) } };
    let { name, arguments: args } = message.params;
    if (name === "whoami") return { result: ok({ kind: "staff", email: "person@example.test" }) };
    if (offline) return { error: { code: -32000, message: "fetch failed" } };
    if (name === "call_tool" && listed.includes("call_tool")) ({ name, arguments: args } = args);
    else if (!listed.includes(name)) return { error: { code: -32602, message: `Unknown tool: ${name}` } };
    calls.push({ name, args, via: message.params.name });
    return tools[name] ? { result: tools[name](args ?? {}) } : { result: refusal("unknown_tool", `No tool ${name}`) };
  };
  return { calls, links, answer };
}

function harness(t, black4, { viewer = VIEWER } = {}) {
  let card;
  const cleanups = [];
  const relayListeners = new Set();
  const relay = { viewer };
  const h = (type, props, ...children) => ({ type, props: props ?? {}, children });
  const ctx = {
    react: { createElement: h, useState: (v) => [v, () => {}], useEffect: () => {} },
    agents: { snapshot: () => ({ running: [] }), addTool: () => () => {} },
    settingsCards: { register: (value) => { card = value; } },
    pages: { register() {} }, panels: { register() {} },
    conversation: { registerLink() {}, registerLinkPreview() {} },
    browser: { available: false },
    relay: {
      snapshot: () => ({ status: "ready", viewer: relay.viewer, session: {} }),
      subscribe: (listener) => { relayListeners.add(listener); return () => relayListeners.delete(listener); },
    },
    effect: (fn) => { const off = fn(); if (off) cleanups.push(off); },
    host: { spawn: async (_, callbacks) => {
      let exit;
      const child = {
        exited: new Promise((resolve) => { exit = resolve; }),
        kill: async () => exit(0),
        write: async (line) => {
          const message = JSON.parse(line);
          const answer = message.id == null ? null : black4.answer(message);
          if (!answer) return;
          const reply = JSON.stringify({ jsonrpc: "2.0", id: message.id, ...answer }) + "\n";
          queueMicrotask(() => callbacks.onStdout(reply));
        },
      };
      return child;
    } },
  };
  apply(ctx);
  t.after(() => { for (const off of cleanups.reverse()) off(); });
  const view = () => section(expand(card.component()));
  return {
    view,
    text: () => texts(view()).join(" "),
    click: async (label) => { const found = find(view(), label); assert.ok(found, `no "${label}" button in: ${texts(view()).join(" ")}`); assert.ok(!found.props.disabled, `"${label}" is disabled`); found.props.onClick(); await settle(); },
    switchViewer: async (key) => { relay.viewer = key; for (const listener of relayListeners) listener(); await settle(); },
  };
}

// Mount every component element, the way a host would.
const expand = (node) => {
  if (!node || typeof node !== "object") return node;
  if (typeof node.type === "function") return expand(node.type(node.props));
  return { ...node, children: node.children.map(expand) };
};
const section = (node) => {
  if (!node || typeof node !== "object") return null;
  if (node.props?.["aria-label"] === "Agent access") return node;
  for (const child of node.children ?? []) { const found = section(child); if (found) return found; }
  return null;
};
const texts = (node) => (node == null || node === false ? [] : typeof node !== "object" ? [String(node)] : (node.children ?? []).flatMap(texts));
const find = (node, label) => {
  if (!node || typeof node !== "object") return null;
  if (node.type === "button" && texts(node).join("") === label) return node;
  for (const child of node.children ?? []) { const found = find(child, label); if (found) return found; }
  return null;
};

test("an unlinked key gets one prompt, and one click links it with the viewer's key", async (t) => {
  const black4 = server();
  const ui = harness(t, black4);
  await settle();
  assert.match(ui.text(), /need this to use Black 4 as you/);
  assert.deepEqual(black4.calls.map((call) => call.name), ["list_agent_owner_keys"], "checking never links");
  await ui.click("Link my agents");
  const linked = black4.calls.find((call) => call.name === "link_agent_owner_key");
  assert.equal(linked.args.ownerKey, VIEWER);
  assert.match(linked.args.label, /^Buzz/);
  assert.equal(linked.via, "call_tool", "a core tool list reaches it through call_tool");
  assert.match(ui.text(), /^Agent access Linked Nov 14, 2026 · No agents yet/);
  assert.ok(find(ui.view(), "Remove…"));
});

test("a key that is already linked shows when and how many agents used it", async (t) => {
  const black4 = server({ links: [link(VIEWER, { agents: [{ agentKey: "c".repeat(64) }, { agentKey: "d".repeat(64) }] }), link(OTHER)] });
  const ui = harness(t, black4);
  await settle();
  assert.match(ui.text(), /Linked Nov 14, 2026 · 2 agents used it/);
  assert.equal(find(ui.view(), "Link my agents"), null);
});

test("tools in the listed set are called directly", async (t) => {
  const black4 = server({ listed: ["whoami", "list_agent_owner_keys", "link_agent_owner_key", "revoke_agent_access"] });
  const ui = harness(t, black4);
  await settle();
  await ui.click("Link my agents");
  assert.deepEqual(black4.calls.map((call) => call.via), ["list_agent_owner_keys", "link_agent_owner_key"]);
});

test("removing asks once, revokes the link by id and offers the link again", async (t) => {
  const black4 = server({ links: [link(VIEWER)] });
  const ui = harness(t, black4);
  await settle();
  await ui.click("Remove…");
  assert.match(ui.text(), /lose Black 4 access/);
  assert.equal(black4.calls.some((call) => call.name === "revoke_agent_access"), false);
  await ui.click("Cancel");
  assert.match(ui.text(), /Linked/);
  await ui.click("Remove…");
  await ui.click("Remove access");
  assert.deepEqual(black4.calls.find((call) => call.name === "revoke_agent_access").args, { linkId: `link-${VIEWER.slice(0, 4)}` });
  assert.ok(black4.links[0].revokedAt);
  assert.ok(find(ui.view(), "Link my agents"));
});

test("the server's own sentence is shown when the key is someone else's or the person is not staff", async (t) => {
  for (const [code, message] of [
    ["owner_key_taken", "This owner key is linked to another person. A key acts for one person at a time."],
    ["forbidden", "Linking an agent owner key needs Black 4 staff access."],
  ]) {
    const black4 = server({ refuseLink: [code, message] });
    const ui = harness(t, black4);
    await settle();
    await ui.click("Link my agents");
    assert.equal(section(ui.view()).children[1].props.role, "alert");
    assert.match(ui.text(), new RegExp(message.replace(/\./g, "\\.")));
    assert.ok(find(ui.view(), "Try again"));
  }
});

test("a server without the link tools says so, without a button", async (t) => {
  const ui = harness(t, server({ listed: ["whoami"] }));
  await settle();
  assert.match(ui.text(), /can't link agents yet/);
  assert.equal(find(ui.view(), "Try again"), null);
  const viaGateway = harness(t, server({ listed: ["whoami", "call_tool"], links: [] }));
  await settle();
  assert.match(viaGateway.text(), /need this/);
});

test("offline is a retryable message, not a link state", async (t) => {
  const ui = harness(t, server({ offline: true }));
  await settle();
  assert.match(ui.text(), /Couldn't reach Black 4/);
  assert.ok(find(ui.view(), "Try again"));
});

test("no Buzz identity yet asks for a community, and a new viewer is checked again", async (t) => {
  const black4 = server({ links: [link(OTHER)] });
  const ui = harness(t, black4, { viewer: null });
  await settle();
  assert.match(ui.text(), /Open a community/);
  assert.equal(black4.calls.length, 0);
  await ui.switchViewer(OTHER);
  assert.match(ui.text(), /Linked/);
  await ui.switchViewer(VIEWER);
  assert.match(ui.text(), /need this/);
});

test("before the Black 4 sign-in finishes there is nothing to click", async (t) => {
  const black4 = server();
  black4.answer = () => null; // never answers initialize: still signing in
  const ui = harness(t, black4);
  await settle();
  assert.match(ui.text(), /Connect Black 4 first/);
  assert.equal(find(ui.view(), "Link my agents"), null);
});

test("readAnswer returns data and turns a refusal into the server's sentence", () => {
  assert.deepEqual(readAnswer(ok({ a: 1 })), { a: 1 });
  assert.deepEqual(readAnswer({ content: [{ type: "text", text: '{"b":2}' }] }), { b: 2 });
  assert.throws(() => readAnswer(refusal("x", "Exactly this.")), /^Error: Exactly this\.$/);
  assert.throws(() => readAnswer(refusal("unknown_tool", "No tool")), (error) => error.code === "unavailable");
  assert.equal(linkLabel("MacIntel"), "Buzz on Mac");
  assert.equal(linkLabel("Win32"), "Buzz on Windows");
  assert.equal(linkLabel(""), "Buzz");
});
